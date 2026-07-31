require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { Server } = require('socket.io');
const Queue = require('bull');
const { Pool } = require('pg');
const { z } = require('zod');
const { Parser } = require('json2csv');
const PDFDocument = require('pdfkit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 4002;
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  req.deviceId = req.headers['x-device-id'] || null;
  next();
});

function deviceFilter(deviceId) {
  return deviceId ? 'AND device_id = $1' : 'AND device_id IS NULL';
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/fortress' });
const defaultUploadDir = path.resolve(__dirname, '..', 'tmp', 'uploads');
const receiptQueue = new Queue('receipt processing', process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  defaultJobOptions: { removeOnComplete: false, removeOnFail: false }
});

io.on('connection', socket => {
  socket.on('subscribe:profile', profileId => {
    socket.join(`profile:${profileId}`);
  });
});

const CATEGORY_KEYWORDS = [
  { keywords: ['starbucks', 'coffee', 'cafe', 'dunkin', 'tim horton'], category: 'Food & Drink' },
  { keywords: ['shell', 'exxon', 'chevron', 'bp', 'gas', 'fuel'], category: 'Fuel' },
  { keywords: ['walmart', 'target', 'costco', 'kroger', 'aldi'], category: 'Groceries' },
  { keywords: ['amazon', 'best buy', 'apple', 'microcenter'], category: 'Shopping' },
  { keywords: ['uber', 'lyft', 'taxi', 'parking'], category: 'Transport' },
  { keywords: ['hilton', 'marriott', 'airbnb', 'hotel'], category: 'Travel' },
  { keywords: ['verizon', 't-mobile', 'at&t', 'comcast'], category: 'Utilities' },
  { keywords: ['doctor', 'hospital', 'pharmacy', 'cvs', 'walgreens'], category: 'Medical' },
];

function autoCategorize(vendor) {
  if (!vendor) return 'Uncategorized';
  const v = vendor.toLowerCase();
  for (const entry of CATEGORY_KEYWORDS) {
    if (entry.keywords.some(k => v.includes(k))) return entry.category;
  }
  return 'Uncategorized';
}

const createProfileSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255),
  monthly_budget: z.number().positive().optional(),
});

const updateBudgetSchema = z.object({
  monthly_budget: z.number().positive('Budget must be positive').nullable(),
});

const receiptQuerySchema = z.object({
  profileId: z.string().uuid().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  category: z.string().optional(),
  project: z.string().optional(),
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

    const fileHash = require('crypto').createHash('md5').update(req.file.buffer).digest('hex');
    const dupCheck = await pool.query(
      'SELECT id FROM receipts WHERE profile_id = $1 AND s3_key = $2 AND total = $3',
      [profileId, `md5:${fileHash}`, req.body.total || 0]
    );
    if (dupCheck.rows.length) {
      return res.status(409).json({ error: 'Duplicate receipt detected', existingId: dupCheck.rows[0].id });
    }

    const projectName = req.body && req.body.projectName ? req.body.projectName : null;
    const isBusiness = req.body && req.body.isBusiness !== undefined ? req.body.isBusiness === 'true' || req.body.isBusiness === true : true;
    const deviceId = req.deviceId;

    const job = await receiptQueue.add({ filePath, originalName: req.file.originalname, profileId, projectName, isBusiness, fileHash, deviceId });
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

    const taxMatch = text.match(/tax\s*:?\s*\$?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2}))/i);
    const taxAmount = taxMatch ? Number(taxMatch[1].replace(/,/g, '')) : null;

    const category = autoCategorize(vendor);
    const isBusiness = req.body && req.body.isBusiness !== undefined ? Boolean(req.body.isBusiness) : true;
    const projectName = req.body && req.body.projectName ? String(req.body.projectName) : null;

    const insert = `INSERT INTO receipts (user_id, s3_key, vendor, date, total, tax_amount, items, category, status, profile_id, is_business, project_name, raw_ocr_text, currency, device_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`;
    const values = [null, source, vendor, date, total, taxAmount, JSON.stringify([]), category, 'processed', profileId, isBusiness, projectName, text, 'USD', req.deviceId];
    const result = await pool.query(insert, values);

    const receiptId = result.rows[0].id;
    io.to(`profile:${profileId}`).emit('receipt:new', { receiptId, vendor, total, date, category });

    res.json({ success: true, receiptId, profileId, vendor, total, date, category, taxAmount });
  } catch (e) {
    console.error('Native vision import error', e);
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/job/:id', async (req, res) => {
  try {
    const job = await receiptQueue.getJob(req.params.id);
    if (!job) {
      return res.json({ id: req.params.id, state: 'removed', message: 'Job not found; it may have completed and been removed from the queue' });
    }
    const state = await job.getState();
    const progress = await job.progress();
    let result = null;
    if (state === 'completed') {
      try { result = await job.finished(); } catch (e) {}
    }
    return res.json({ id: job.id, state, progress, data: job.data, attempts: job.attemptsMade, result });
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
});

app.get('/api/receipts', async (req, res) => {
  try {
    const query = receiptQuerySchema.parse(req.query);
    let sql = 'SELECT id, vendor, date, total, tax_amount, category, currency, is_business, project_name, created_at, confidence_score FROM receipts WHERE 1=1';
    const params = [];
    let idx = 1;

    if (req.deviceId) {
      sql += ` AND device_id = $${idx++}`;
      params.push(req.deviceId);
    } else {
      sql += ' AND device_id IS NULL';
    }

    if (query.profileId) {
      sql += ` AND profile_id = $${idx++}`;
      params.push(query.profileId);
    }
    if (query.startDate) {
      sql += ` AND date >= $${idx++}`;
      params.push(query.startDate);
    }
    if (query.endDate) {
      sql += ` AND date <= $${idx++}`;
      params.push(query.endDate);
    }
    if (query.category) {
      sql += ` AND category = $${idx++}`;
      params.push(query.category);
    }
    if (query.project) {
      sql += ` AND project_name = $${idx++}`;
      params.push(query.project);
    }

    sql += ' ORDER BY created_at DESC LIMIT 100';
    const r = await pool.query(sql, params);
    res.json({ receipts: r.rows });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid query params', details: e.errors });
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

app.patch('/api/receipts/:id', async (req, res) => {
  try {
    const schema = z.object({
      vendor: z.string().max(255).optional(),
      category: z.string().max(100).optional(),
      is_business: z.boolean().optional(),
      business_notes: z.string().optional(),
      project_name: z.string().max(100).nullable().optional(),
      tax_category: z.string().max(50).optional(),
      is_verified: z.boolean().optional(),
    });
    const body = schema.parse(req.body);
    const sets = [];
    const params = [];
    let idx = 1;
    for (const [key, val] of Object.entries(body)) {
      if (val !== undefined) {
        sets.push(`${key} = $${idx++}`);
        params.push(val);
      }
    }
    if (!sets.length) return res.status(400).json({ error: 'No valid fields to update' });
    params.push(req.params.id);
    const deviceClause = req.deviceId ? ` AND device_id = '${req.deviceId}'` : ' AND device_id IS NULL';
    const r = await pool.query(`UPDATE receipts SET ${sets.join(', ')} WHERE id = $${idx}${deviceClause} RETURNING *`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ receipt: r.rows[0] });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid fields', details: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/receipts/:id', async (req, res) => {
  try {
    const deviceClause = req.deviceId ? 'AND device_id = $2' : 'AND device_id IS NULL';
    const params = [req.params.id];
    if (req.deviceId) params.push(req.deviceId);
    const r = await pool.query(`DELETE FROM receipts WHERE id = $1 ${deviceClause} RETURNING id`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ deleted: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/profiles', async (req, res) => {
  try {
    const deviceClause = req.deviceId ? 'WHERE device_id = $1' : 'WHERE device_id IS NULL';
    const params = req.deviceId ? [req.deviceId] : [];
    const r = await pool.query(`SELECT id, name, monthly_budget, created_at FROM profiles ${deviceClause} ORDER BY created_at DESC`, params);
    res.json({ profiles: r.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/profiles', async (req, res) => {
  try {
    const body = createProfileSchema.parse(req.body);
    const r = await pool.query('INSERT INTO profiles (name, monthly_budget, device_id) VALUES ($1, $2, $3) RETURNING id, name, monthly_budget', [body.name, body.monthly_budget || null, req.deviceId]);
    res.json({ profile: r.rows[0] });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid profile data', details: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

app.patch('/api/profiles/:id', async (req, res) => {
  try {
    const body = updateBudgetSchema.parse(req.body);
    const deviceClause = req.deviceId ? 'AND device_id = $3' : 'AND device_id IS NULL';
    const params = [body.monthly_budget, req.params.id];
    if (req.deviceId) params.push(req.deviceId);
    const r = await pool.query(`UPDATE profiles SET monthly_budget = $1 WHERE id = $2 ${deviceClause} RETURNING id, name, monthly_budget`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ profile: r.rows[0] });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid data', details: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/profiles/:id', async (req, res) => {
  try {
    const deviceClause = req.deviceId ? 'AND device_id = $2' : 'AND device_id IS NULL';
    const params = [req.params.id];
    if (req.deviceId) params.push(req.deviceId);
    const r = await pool.query(`DELETE FROM profiles WHERE id = $1 ${deviceClause} RETURNING id`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ deleted: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/profiles/summary', async (req, res) => {
  try {
    const deviceClause = req.deviceId ? `p.device_id = '${req.deviceId}'` : 'p.device_id IS NULL';
    const r = await pool.query(`
      SELECT p.id, p.name, p.monthly_budget,
             COUNT(r.id) AS receipt_count,
             COALESCE(SUM(r.total), 0) AS total_spent,
             COALESCE(SUM(r.total) FILTER (WHERE r.date >= date_trunc('month', CURRENT_DATE)), 0) AS monthly_spent,
             MAX(r.created_at) AS latest_receipt_at
      FROM profiles p
      LEFT JOIN receipts r ON r.profile_id = p.id AND (${deviceClause.replace('p.', 'r.')})
      WHERE ${deviceClause}
      GROUP BY p.id, p.name, p.monthly_budget
      ORDER BY total_spent DESC, receipt_count DESC
    `);
    const profiles = r.rows.map(p => ({
      ...p,
      monthly_spent: Number(p.monthly_spent),
      total_spent: Number(p.total_spent),
      receipt_count: Number(p.receipt_count),
      budget_used_pct: p.monthly_budget && Number(p.monthly_budget) > 0
        ? Math.min(100, Math.round((Number(p.monthly_spent) / Number(p.monthly_budget)) * 100))
        : null,
      budget_remaining: p.monthly_budget && Number(p.monthly_budget) > 0
        ? Math.max(0, Number(p.monthly_budget) - Number(p.monthly_spent))
        : null,
    }));
    res.json({ profiles });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/profiles/:id/receipts', async (req, res) => {
  try {
    const deviceClause = req.deviceId ? 'AND device_id = $2' : 'AND device_id IS NULL';
    const params = [req.params.id];
    if (req.deviceId) params.push(req.deviceId);
    const r = await pool.query(
      `SELECT id, vendor, date, total, tax_amount, category, currency, is_business, project_name, tax_category, created_at FROM receipts WHERE profile_id = $1 ${deviceClause} ORDER BY created_at DESC`,
      params
    );
    res.json({ receipts: r.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/profiles/:id/timeseries', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 12;
    const deviceClause = req.deviceId ? 'AND device_id = $3' : 'AND device_id IS NULL';
    const params = [req.params.id, months];
    if (req.deviceId) params.push(req.deviceId);
    const r = await pool.query(`
      SELECT date_trunc('month', date) AS month,
             SUM(total) AS total_spent,
             COUNT(id) AS receipt_count
      FROM receipts
      WHERE profile_id = $1 AND date >= date_trunc('month', CURRENT_DATE) - ($2 || ' months')::INTERVAL ${deviceClause}
      GROUP BY month
      ORDER BY month DESC
    `, params);
    res.json({ series: r.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/profiles/:id/export/csv', async (req, res) => {
  try {
    const deviceClause = req.deviceId ? 'AND device_id = $2' : 'AND device_id IS NULL';
    const params = [req.params.id];
    if (req.deviceId) params.push(req.deviceId);
    const r = await pool.query(
      `SELECT id, vendor, date, total, tax_amount, category, is_business, project_name, business_notes, created_at FROM receipts WHERE profile_id = $1 ${deviceClause} ORDER BY date DESC`,
      params
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No receipts found' });
    const parser = new Parser();
    const csv = parser.parse(r.rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=receipts-${req.params.id}.csv`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/profiles/:id/export/pdf', async (req, res) => {
  try {
    const deviceClause = req.deviceId ? 'AND device_id = $2' : 'AND device_id IS NULL';
    const params = [req.params.id];
    if (req.deviceId) params.push(req.deviceId);
    const r = await pool.query(
      `SELECT id, vendor, date, total, tax_amount, category, is_business, project_name, business_notes, created_at FROM receipts WHERE profile_id = $1 ${deviceClause} ORDER BY date DESC`,
      params
    );
    const profile = await pool.query('SELECT name FROM profiles WHERE id = $1', [req.params.id]);
    const profileName = profile.rows.length ? profile.rows[0].name : 'Unknown';

    const doc = new PDFDocument({ margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=receipts-${req.params.id}.pdf`);
    doc.pipe(res);

    doc.fontSize(20).text('Fortress Hub - Receipt Report', { align: 'center' });
    doc.fontSize(14).text(`Profile: ${profileName}`, { align: 'center' });
    doc.moveDown();
    doc.fontSize(10).text(`Generated: ${new Date().toISOString().split('T')[0]}`, { align: 'right' });
    doc.moveDown();

    let totalAll = 0;
    for (const row of r.rows) {
      totalAll += Number(row.total || 0);
      doc.fontSize(11).text(`${row.date}  |  ${row.vendor}  |  $${Number(row.total).toFixed(2)}  |  ${row.category || ''}  |  ${row.is_business ? 'Business' : 'Personal'}`);
      if (row.business_notes) doc.fontSize(9).text(`     Notes: ${row.business_notes}`, { indent: 20 });
      doc.moveDown(0.3);
    }

    doc.moveDown();
    doc.fontSize(14).text(`Total: $${totalAll.toFixed(2)}`, { align: 'right' });
    doc.end();
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/analytics/business-tax', async (req, res) => {
  try {
    if (!req.query.profileId) return res.status(400).json({ error: 'profileId required' });
    const deviceClause = req.deviceId ? 'AND device_id = $2' : 'AND device_id IS NULL';
    const params = [req.query.profileId];
    if (req.deviceId) params.push(req.deviceId);
    const r = await pool.query(`
      SELECT
        COALESCE(tax_category, 'Uncategorized') AS tax_category,
        COUNT(id) AS count,
        SUM(total) AS total_deduction
      FROM receipts
      WHERE is_business = true AND profile_id = $1 ${deviceClause}
      GROUP BY tax_category
      ORDER BY total_deduction DESC
    `, params);
    const grandTotal = r.rows.reduce((acc, row) => acc + Number(row.total_deduction || 0), 0);
    res.json({ deductions: r.rows, grand_total: grandTotal });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/analytics/spending-trends', async (req, res) => {
  try {
    if (!req.query.profileId) return res.status(400).json({ error: 'profileId required' });
    const months = parseInt(req.query.months) || 6;
    const deviceClause = req.deviceId ? 'AND device_id = $3' : 'AND device_id IS NULL';
    const params = [req.query.profileId, months];
    if (req.deviceId) params.push(req.deviceId);
    const r = await pool.query(`
      SELECT date_trunc('month', date) AS month,
             category,
             SUM(total) AS total_spent,
             COUNT(id) AS receipt_count
      FROM receipts
      WHERE profile_id = $1 AND date >= date_trunc('month', CURRENT_DATE) - ($2 || ' months')::INTERVAL ${deviceClause}
      GROUP BY month, category
      ORDER BY month DESC, total_spent DESC
    `, params);
    res.json({ trends: r.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/mileage', async (req, res) => {
  try {
    const profileId = req.query.profileId;
    if (!profileId) return res.status(400).json({ error: 'profileId required' });
    const deviceClause = req.deviceId ? 'AND device_id = $2' : 'AND device_id IS NULL';
    const params = [profileId];
    if (req.deviceId) params.push(req.deviceId);
    const r = await pool.query(`SELECT * FROM mileage_logs WHERE profile_id = $1 ${deviceClause} ORDER BY date DESC`, params);
    res.json({ mileage: r.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/mileage', async (req, res) => {
  try {
    const schema = z.object({
      profile_id: z.string().uuid(),
      date: z.string().optional(),
      start_odometer: z.number().int().positive().optional(),
      end_odometer: z.number().int().positive().optional(),
      purpose: z.string().optional(),
      project_name: z.string().optional(),
      is_business: z.boolean().default(true),
    });
    const body = schema.parse(req.body);
    const r = await pool.query(
      `INSERT INTO mileage_logs (profile_id, date, start_odometer, end_odometer, purpose, project_name, is_business, device_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [body.profile_id, body.date || new Date().toISOString().split('T')[0], body.start_odometer || null, body.end_odometer || null, body.purpose || null, body.project_name || null, body.is_business, req.deviceId]
    );
    io.to(`profile:${body.profile_id}`).emit('mileage:new', r.rows[0]);
    res.json({ mileage: r.rows[0] });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid data', details: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/mileage/:id', async (req, res) => {
  try {
    const deviceClause = req.deviceId ? 'AND device_id = $2' : 'AND device_id IS NULL';
    const params = [req.params.id];
    if (req.deviceId) params.push(req.deviceId);
    const r = await pool.query(`DELETE FROM mileage_logs WHERE id = $1 ${deviceClause} RETURNING id`, params);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ deleted: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/projects', async (req, res) => {
  try {
    const profileId = req.query.profileId;
    if (!profileId) return res.status(400).json({ error: 'profileId required' });
    const deviceClause = req.deviceId ? 'AND device_id = $2' : 'AND device_id IS NULL';
    const params = [profileId];
    if (req.deviceId) params.push(req.deviceId);
    const r = await pool.query(`SELECT * FROM projects WHERE profile_id = $1 ${deviceClause} ORDER BY name`, params);
    res.json({ projects: r.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/projects', async (req, res) => {
  try {
    const schema = z.object({
      name: z.string().min(1).max(255),
      profile_id: z.string().uuid(),
      description: z.string().optional(),
    });
    const body = schema.parse(req.body);
    const r = await pool.query('INSERT INTO projects (name, profile_id, description) VALUES ($1, $2, $3) RETURNING *', [body.name, body.profile_id, body.description || null]);
    res.json({ project: r.rows[0] });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid data', details: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/projects/:id', async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM projects WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ deleted: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/categories', (req, res) => {
  res.json({ categories: CATEGORY_KEYWORDS.map(c => c.category).filter((v, i, a) => a.indexOf(v) === i) });
});

server.listen(PORT, () => console.log(`Backend listening on ${PORT}`));

const JOB_AGE = parseInt(process.env.JOB_AGE || '3600', 10);
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
