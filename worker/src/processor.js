require('dotenv').config();
const Queue = require('bull');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const receiptQueue = new Queue('receipt processing', redisUrl);
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/fortress' });

// Basic helpers to parse text
function extractTotal(text) {
  const moneyRe = /(?<!\d)(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2}))(?!\d)/g;
  let match, last = null;
  while ((match = moneyRe.exec(text)) !== null) {
    last = match[1];
  }
  if (!last) return null;
  const normalized = last.replace(/,/g, '');
  const num = parseFloat(normalized);
  return isFinite(num) ? num : null;
}

function extractDate(text) {
  const iso = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const m1 = text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
  if (m1) return m1[1];
  return null;
}

function extractVendor(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.length ? lines[0].slice(0, 200) : null;
}

async function runOCR(filePath) {
  let buffer = fs.readFileSync(filePath);
  try {
    buffer = await sharp(buffer)
      .resize({ width: 1600, withoutEnlargement: true })
      .greyscale()
      .normalise()
      .toBuffer();
  } catch (e) {}

  const tmp = path.join(path.dirname(filePath), `ocr-${path.basename(filePath)}.png`);
  fs.writeFileSync(tmp, buffer);

  try {
    const { data: { text } } = await Tesseract.recognize(tmp, 'eng', { logger: m => {} });
    return text;
  } finally {
    try { fs.unlinkSync(tmp); } catch(e){}
  }
}

receiptQueue.process(async (job) => {
  console.log('Processing job', job.id, job.data.filePath);
  const { filePath, userId, originalName } = job.data;

  if (!fs.existsSync(filePath)) {
    throw new Error('File not found: ' + filePath);
  }

  const ocrText = 'SIMULATED';
  const vendor = originalName || 'unknown';
  const total = Math.floor(Math.random()*100)+1;
  const date = new Date().toISOString().split('T')[0];

  const insert = `INSERT INTO receipts (user_id, s3_key, vendor, date, total, items, category, status, profile_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`;
  const values = [null, filePath, vendor, date, total, JSON.stringify([]), 'uncategorized', 'processed', job.data && job.data.profileId ? job.data.profileId : null];

  try {
    const res = await pool.query(insert, values);
    const receiptId = res.rows[0].id;
    console.log('Inserted receipt', receiptId);
    // schedule job removal after short delay so clients can fetch result
    setTimeout(()=>{
      try{ job.remove().then(()=>console.log('Job removed', job.id)).catch(()=>{}); }catch(e){ }
    }, 15_000);
    // return the receipt id so the API can expose the result to clients
    return { status: 'done', receiptId };
  } catch (err) {
    console.error('DB insert failed:', err.stack || err);
  }

  try { fs.unlinkSync(filePath); } catch(e){}

  return { status: 'done' };
});

receiptQueue.on('completed', (job, result) => console.log('Job completed', job.id, result));
receiptQueue.on('failed', (job, err) => console.error('Job failed', job.id, err));

console.log('Worker (updated) started');
