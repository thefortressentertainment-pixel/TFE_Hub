require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Queue = require('bull');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 4002;
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/fortress' });
const defaultUploadDir = path.resolve(__dirname, '..', 'tmp', 'uploads');
const receiptQueue = new Queue('receipt processing', process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  // Keep jobs for a short while so clients can poll status reliably.
  defaultJobOptions: { removeOnComplete: false, removeOnFail: false }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/', (req, res) => res.json({ app: 'Fortress Hub backend', status: 'ok' }));

app.post('/api/upload', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const outDir = process.env.UPLOAD_DIR || defaultUploadDir;
    fs.mkdirSync(outDir, { recursive: true });
    const filename = `${Date.now()}-${req.file.originalname.replace(/\s+/g, '_')}`;
    const filePath = path.join(outDir, filename);
    fs.writeFileSync(filePath, req.file.buffer);
    const profileId = req.body && req.body.profileId ? req.body.profileId : null;
    if (!profileId) {
      return res.status(400).json({ error: 'Please choose a profile before uploading' });
    }

    const profileCheck = await pool.query('SELECT id FROM profiles WHERE id = $1', [profileId]);
    if (!profileCheck.rows.length) {
      return res.status(400).json({ error: 'Selected profile was not found' });
    }

    const job = await receiptQueue.add({ filePath, originalName: req.file.originalname, profileId });
    res.json({ success: true, jobId: job.id, filePath, profileId });
  } catch (e) {
    console.error('Upload error', e);
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/native-vision', async (req, res) => {
  try {
    const text = req.body && req.body.text ? String(req.body.text) : '';
    const source = req.body && req.body.source ? String(req.body.source) : 'native-vision';
    if (!text.trim()) return res.status(400).json({ error: 'No OCR text provided' });

    const profileId = req.body && req.body.profileId ? req.body.profileId : null;
    if (!profileId) {
      return res.status(400).json({ error: 'Please choose a profile before sending native OCR data' });
    }

    const profileCheck = await pool.query('SELECT id FROM profiles WHERE id = $1', [profileId]);
    if (!profileCheck.rows.length) {
      return res.status(400).json({ error: 'Selected profile was not found' });
    }

    const vendor = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0] || source;
    const totalMatch = text.match(/(?<!\d)(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2}))(?!\d)/g);
    const total = totalMatch && totalMatch.length ? Number(totalMatch[totalMatch.length - 1].replace(/,/g, '')) : 0;
    const dateMatch = text.match(/(\d{4}-\d{2}-\d{2}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
    const date = dateMatch ? dateMatch[1] : new Date().toISOString().split('T')[0];

    const insert = `INSERT INTO receipts (user_id, s3_key, vendor, date, total, items, category, status, profile_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`;
    const values = [null, source, vendor, date, total, JSON.stringify([]), 'uncategorized', 'processed', profileId];
    const result = await pool.query(insert, values);

    res.json({ success: true, receiptId: result.rows[0].id, profileId, vendor, total, date });
  } catch (e) {
    console.error('Native vision import error', e);
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/job/:id', async (req, res) => {
  try {
    const job = await receiptQueue.getJob(req.params.id);
    if (!job) {
      // Job may have already completed and been removed; return a helpful message
      return res.json({ id: req.params.id, state: 'removed', message: 'Job not found; it may have completed and been removed from the queue' });
    }
    const state = await job.getState();
    const progress = await job.progress();
    let result = null;
    if (state === 'completed') {
      try {
        result = await job.finished();
      } catch (e) {
        // ignore
      }
    }
    return res.json({ id: job.id, state, progress, data: job.data, attempts: job.attemptsMade, result });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.get('/api/receipts', async (req, res) => {
  try {
    if (req.query.profileId) {
      const r = await pool.query('SELECT id, vendor, date, total, created_at FROM receipts WHERE profile_id = $1 ORDER BY created_at DESC', [req.query.profileId]);
      return res.json({ receipts: r.rows });
    }
    const r = await pool.query('SELECT id, vendor, date, total, created_at FROM receipts ORDER BY created_at DESC LIMIT 50');
    res.json({ receipts: r.rows });
  } catch (e) {
    console.error('Receipts query error', e);
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/receipts/:id', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM receipts WHERE id = $1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ receipt: r.rows[0] });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/profiles', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name, created_at FROM profiles ORDER BY created_at DESC');
    res.json({ profiles: r.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/profiles', async (req, res) => {
  try {
    const name = req.body && req.body.name ? req.body.name : null;
    if (!name) return res.status(400).json({ error: 'missing name' });
    const r = await pool.query('INSERT INTO profiles (name) VALUES ($1) RETURNING id, name', [name]);
    res.json({ profile: r.rows[0] });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/profiles/summary', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT p.id, p.name,
             COUNT(r.id) AS receipt_count,
             COALESCE(SUM(r.total), 0) AS total_spent,
             MAX(r.created_at) AS latest_receipt_at
      FROM profiles p
      LEFT JOIN receipts r ON r.profile_id = p.id
      GROUP BY p.id, p.name
      ORDER BY total_spent DESC, receipt_count DESC
    `);
    res.json({ profiles: r.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/profiles/:id/receipts', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, vendor, date, total, created_at FROM receipts WHERE profile_id = $1 ORDER BY created_at DESC', [req.params.id]);
    res.json({ receipts: r.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.listen(PORT, () => console.log(`Backend listening on ${PORT}`));

// Periodic cleanup: remove completed/failed jobs older than JOB_AGE seconds
const JOB_AGE = parseInt(process.env.JOB_AGE || '3600', 10); // seconds
setInterval(async () => {
  try {
    const completed = await receiptQueue.getCompleted();
    for (const id of completed) {
      try {
        const j = await receiptQueue.getJob(id);
        if (!j) continue;
        const finishedAt = j.finishedOn || j.timestamp;
        if (finishedAt && (Date.now() - finishedAt) > JOB_AGE * 1000) {
          await j.remove();
          console.log('Cleaned job', id);
        }
      } catch (e) { }
    }
  } catch (e) { }
}, 60 * 1000);
