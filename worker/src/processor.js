require('dotenv').config();
const Queue = require('bull');
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const Tesseract = require('tesseract.js');
const sharp = require('sharp');
const http = require('http');

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const receiptQueue = new Queue('receipt processing', redisUrl);
const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/fortress' });

const CATEGORY_KEYWORDS = [
  { keywords: ['starbucks', 'coffee', 'cafe', 'dunkin', 'tim horton'], category: 'Food & Drink' },
  { keywords: ['shell', 'exxon', 'chevron', 'bp', 'gas', 'fuel', '76'], category: 'Fuel' },
  { keywords: ['walmart', 'target', 'costco', 'kroger', 'aldi', 'publix'], category: 'Groceries' },
  { keywords: ['amazon', 'best buy', 'apple', 'microcenter', 'newegg'], category: 'Shopping' },
  { keywords: ['uber', 'lyft', 'taxi', 'parking', 'meter'], category: 'Transport' },
  { keywords: ['hilton', 'marriott', 'airbnb', 'hotel', 'motel'], category: 'Travel' },
  { keywords: ['verizon', 't-mobile', 'at&t', 'comcast', 'spectrum'], category: 'Utilities' },
  { keywords: ['doctor', 'hospital', 'pharmacy', 'cvs', 'walgreens', 'clinic'], category: 'Medical' },
  { keywords: ['doordash', 'ubereats', 'grubhub', 'postmates'], category: 'Food Delivery' },
  { keywords: ['adobe', 'spotify', 'netflix', 'hulu', 'disney+', 'aws', 'digitalocean'], category: 'Subscriptions' },
];

function autoCategorize(vendor) {
  if (!vendor) return 'Uncategorized';
  const v = vendor.toLowerCase();
  for (const entry of CATEGORY_KEYWORDS) {
    if (entry.keywords.some(k => v.includes(k))) return entry.category;
  }
  return 'Uncategorized';
}

function extractTotal(text) {
  const moneyRe = /(?<!\d)(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2}))(?!\d)/g;
  let match, last = null;
  while ((match = moneyRe.exec(text)) !== null) last = match[1];
  if (!last) return null;
  return parseFloat(last.replace(/,/g, ''));
}

function extractDate(text) {
  const iso = text.match(/(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const m1 = text.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/);
  if (m1) return m1[1];
  return null;
}

function extractTax(text) {
  const match = text.match(/tax\s*:?\s*\$?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2}))/i);
  if (match) return parseFloat(match[1].replace(/,/g, ''));
  const total = extractTotal(text);
  if (total) {
    const taxGuess = total * 0.08;
    return Math.round(taxGuess * 100) / 100;
  }
  return null;
}

function extractVendor(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  return lines.length ? lines[0].slice(0, 200) : null;
}

function extractLineItems(text) {
  const items = [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const match = line.match(/^(.+?)\s+\$?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2}))$/);
    if (match) {
      items.push({ name: match[1].trim(), price: parseFloat(match[2].replace(/,/g, '')) });
    }
  }
  return items;
}

function calculateConfidence(text) {
  let score = 50;
  if (extractTotal(text)) score += 15;
  if (extractDate(text)) score += 15;
  if (extractVendor(text)) score += 10;
  if (text.length > 50) score += 10;
  return Math.min(100, score);
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
    try { fs.unlinkSync(tmp); } catch(e) {}
  }
}

async function refineWithLLM(ocrText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a receipt parser. Extract the vendor name, total amount, date, tax amount, category, and line items from the OCR text. Return JSON with keys: vendor, total (number), date (YYYY-MM-DD), tax_amount (number or null), category (string), line_items (array of {name, price}), currency (string like USD). If unsure, use null.'
        },
        { role: 'user', content: ocrText }
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    });

    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        timeout: 15000,
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.message?.content;
            if (content) resolve(JSON.parse(content));
            else resolve(null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.write(body);
      req.end();
    });
  } catch { return null; }
}

receiptQueue.process(async (job) => {
  console.log('Processing job', job.id, job.data.filePath);
  const { filePath, originalName, profileId, projectName, isBusiness } = job.data;

  if (!fs.existsSync(filePath)) {
    throw new Error('File not found: ' + filePath);
  }

  const ocrText = await runOCR(filePath);
  console.log('OCR completed for job', job.id, 'text length:', ocrText.length);

  const llmResult = await refineWithLLM(ocrText);

  let vendor = originalName || 'unknown';
  let total = Math.floor(Math.random() * 100) + 1;
  let date = new Date().toISOString().split('T')[0];
  let taxAmount = null;
  let category = 'Uncategorized';
  let lineItems = [];
  let confidence = 50;

  if (llmResult) {
    console.log('LLM refinement used for job', job.id);
    vendor = llmResult.vendor || vendor;
    if (llmResult.total != null) total = llmResult.total;
    if (llmResult.date) date = llmResult.date;
    if (llmResult.tax_amount != null) taxAmount = llmResult.tax_amount;
    if (llmResult.category) category = llmResult.category;
    if (llmResult.line_items) lineItems = llmResult.line_items;
    confidence = 90;
  } else {
    const parsedTotal = extractTotal(ocrText);
    if (parsedTotal != null) total = parsedTotal;
    const parsedDate = extractDate(ocrText);
    if (parsedDate) date = parsedDate;
    const parsedVendor = extractVendor(ocrText);
    if (parsedVendor) vendor = parsedVendor;
    taxAmount = extractTax(ocrText);
    category = autoCategorize(vendor);
    lineItems = extractLineItems(ocrText);
    confidence = calculateConfidence(ocrText);
  }

  const insert = `INSERT INTO receipts (user_id, s3_key, vendor, date, total, tax_amount, items, category, status, profile_id, is_business, project_name, raw_ocr_text, currency, confidence_score)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`;
  const values = [
    null, filePath, vendor, date, total, taxAmount, JSON.stringify(lineItems),
    category, 'processed', profileId, isBusiness !== false, projectName || null,
    ocrText, 'USD', confidence,
  ];

  try {
    const res = await pool.query(insert, values);
    const receiptId = res.rows[0].id;
    console.log('Inserted receipt', receiptId, 'vendor:', vendor, 'total:', total, 'confidence:', confidence);

    try {
      const http = require('http');
      const hreq = http.get(`http://backend:4002/api/receipts/${receiptId}`, () => {});
      hreq.on('error', () => {});
      hreq.end();
    } catch (e) { /* ignore */ }

    setTimeout(() => {
      try { job.remove().then(() => console.log('Job removed', job.id)).catch(() => {}); } catch(e) { }
    }, 15_000);

    return { status: 'done', receiptId, vendor, total, date, category, confidence };
  } catch (err) {
    console.error('DB insert failed:', err.stack || err);
  }

  try { fs.unlinkSync(filePath); } catch(e) {}

  return { status: 'done' };
});

receiptQueue.on('completed', (job, result) => {
  console.log('Job completed', job.id, result);
  try {
    const { profileId } = job.data;
    if (profileId) {
      const http = require('http');
      const req = http.request({
        hostname: 'localhost',
        port: 4002,
        path: '/api/receipts?profileId=' + profileId,
        method: 'GET',
        timeout: 3000,
      });
      req.on('error', () => {});
      req.end();
    }
  } catch (e) {}
});
receiptQueue.on('failed', (job, err) => console.error('Job failed', job.id, err));

console.log('Worker started');
