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
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = process.env.PORT || 4002;
// Bind explicitly so tunnel traffic (Tailscale 100.x / ts.net, LAN) is
// reachable. HOST=127.0.0.1 locks it to loopback; HOST=<tailscale-ip> locks it
// to the tailnet only.
const HOST = process.env.HOST || '0.0.0.0';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!file) return cb(new Error('No file uploaded'), false);
    if (!['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'application/pdf'].includes(file.mimetype)) {
      return cb(new Error('Invalid file type. Please upload an image or PDF.'), false);
    }
    cb(null, true);
  }
});
const JWT_SECRET = process.env.JWT_SECRET || 'fortress-dev-secret-change-me';

const failedAttempts = new Map();
function checkRateLimit(key) {
  const windowMs = 15 * 60 * 1000;
  const maxAttempts = 5;
  const now = Date.now();
  const entry = failedAttempts.get(key) || { count: 0, firstAttempt: now };
  if (now - entry.firstAttempt > windowMs) {
    entry.count = 0;
    entry.firstAttempt = now;
  }
  entry.count++;
  failedAttempts.set(key, entry);
  if (entry.count > maxAttempts) {
    const remaining = Math.ceil((windowMs - (now - entry.firstAttempt)) / 1000);
    return { blocked: true, remainingSeconds: remaining };
  }
  return { blocked: false, attemptsRemaining: maxAttempts - entry.count };
}

// ---- Agent overload guard (text-bomb / spam defense) ----
// Separate from the login limiter: bounds how aggressively any one actor can
// drive JARV, so a hostile blast of messages can't pin the relay in a loop.
const AGENT_MAX_PER_MIN = 40;
const AGENT_MAX_CONCURRENT = 3;
const agentHits = new Map();   // key -> { count, windowStart }
const agentInflight = new Map(); // key -> count
function checkAgentRate(key) {
  const now = Date.now();
  const e = agentHits.get(key) || { count: 0, windowStart: now };
  if (now - e.windowStart > 60000) { e.count = 0; e.windowStart = now; }
  e.count++;
  agentHits.set(key, e);
  const inflight = agentInflight.get(key) || 0;
  if (inflight >= AGENT_MAX_CONCURRENT) return { retryAfter: 3, reason: 'JARV is busy — too many of your requests in flight at once' };
  if (e.count > AGENT_MAX_PER_MIN) { const r = 60 - Math.floor((now - e.windowStart) / 1000); return { retryAfter: Math.max(1, r), reason: 'agent request limit reached — slow down and let JARV catch up' }; }
  return { ok: true };
}
function agentBusy(key, busy) {
  const c = agentInflight.get(key) || 0;
  agentInflight.set(key, Math.max(0, busy === true ? c + 1 : c - 1));
  if (busy !== true && c <= 0) agentInflight.delete(key);
}

function validatePasswordStrength(password) {
  const errors = [];
  if (password.length < 8) errors.push('Password must be at least 8 characters');
  if (password.length > 64) errors.push('Password must be less than 64 characters');
  if (!/[a-z]/.test(password)) errors.push('Password must contain a lowercase letter');
  if (!/[A-Z]/.test(password)) errors.push('Password must contain an uppercase letter');
  if (!/[0-9]/.test(password)) errors.push('Password must contain a number');
  return errors;
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));

app.use((req, res, next) => {
  req.deviceId = req.headers['x-device-id'] || null;
  req.userId = null;
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) {
    try {
      const decoded = jwt.verify(auth.slice(7), JWT_SECRET);
      req.userId = decoded.userId || null;
    } catch (e) {}
  }
  next();
});

function deviceFilter(deviceId) {
  return deviceId ? 'AND device_id = $1' : 'AND device_id IS NULL';
}

function tenantFilter(req, table, paramIndex) {
  const t = table ? table + '.' : '';
  if (req.userId) {
    return { sql: ` AND ${t}owner_id = $${paramIndex}`, params: [req.userId] };
  }
  if (req.deviceId) {
    return { sql: ` AND ${t}device_id = $${paramIndex}`, params: [req.deviceId] };
  }
  return { sql: ` AND 1=0`, params: [] };
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/fortress' });
const defaultUploadDir = path.resolve(__dirname, '..', 'tmp', 'uploads');
const receiptQueue = new Queue('receipt processing', process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  defaultJobOptions: { removeOnComplete: false, removeOnFail: false }
});
const genieMesh = require('./genieMesh');
const locationService = require('./locationService');
const locService = locationService.makeLocationService({ pool, log: console });
const aiBridge = require('./aiBridge');
const aiKeys = require('./aiKeys');
const ai = aiBridge.makeAiBridge({ pool, log: console, config: process.env, getMesh: () => mesh });
const mesh = genieMesh.makeMesh({ pool, log: console, ai, location: locService });
const jarvAgent = require('./jarvAgent');
const jarv = jarvAgent.makeJarvAgent({ pool, mesh, ai, log: console, locate: () => locService.locate() });
mesh.setJarv(jarv);
mesh.setLocation(locService);
// Telegram tunnel — outbound-only command channel (long-poll, zero inbound
// ports) so JARV-Genie keeps an always-available path behind CGNAT/satellite.
const telegramTunnel = require('./telegramTunnel');
const telegram = telegramTunnel.makeTelegramTunnel({ pool, mesh, log: console, config: process.env, jarv });
// JARV MCP server — exposes the hub's tools to AI coding clients over SSE.
const jarvMcp = require('./jarvMcp');

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

const distDir = path.resolve(__dirname, '..', '..', 'frontend', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/privacy', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ReceiptVault — Privacy Policy</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:680px;margin:40px auto;padding:0 20px;color:#101828;line-height:1.6">
<h1>ReceiptVault Privacy Policy</h1>
<p><em>Last updated: July 31, 2026</em></p>
<h2>What we collect</h2>
<p><strong>Account:</strong> your email address and a password (stored securely, hashed).</p>
<p><strong>Receipts:</strong> images you upload, plus the vendor, date, and amount we read from them.</p>
<p><strong>Location:</strong> with your permission, we track location only while a shift is active, to calculate mileage for tax purposes.</p>
<h2>How we use it</h2>
<p>Your data is used solely to provide the ReceiptVault service: storing receipts, tracking expenses, and calculating mileage. We do not sell your data.</p>
<h2>Storage</h2>
<p>Data is stored on secured cloud servers. Receipt images are processed to extract text and stored for your records.</p>
<h2>Your rights</h2>
<p>You may delete receipts, profiles, and your account at any time. To delete your account, email support with your account email and we will remove your data within 30 days.</p>
<h2>Contact</h2>
<p>For privacy questions or account deletion, contact: <strong>support@receiptvault.app</strong></p>
</body></html>`);
});
app.get('/', (req, res) => {
  if (fs.existsSync(path.join(distDir, 'index.html'))) {
    return res.sendFile(path.join(distDir, 'index.html'));
  }
  res.json({ app: 'ReceiptVault backend', status: 'ok' });
});

const authSchema = z.object({
  email: z.string().email('Valid email required').max(255),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const body = authSchema.parse(req.body);
    const email = body.email.toLowerCase();
    const rl = checkRateLimit(`register:${email}`);
    if (rl.blocked) return res.status(429).json({ error: `Too many attempts. Try again in ${rl.remainingSeconds}s.` });
    const strengthErrors = validatePasswordStrength(body.password);
    if (strengthErrors.length) return res.status(400).json({ error: strengthErrors.join('; ') });
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }
    const passwordHash = await bcrypt.hash(body.password, 12);
    const r = await pool.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email', [email, passwordHash]);
    const token = jwt.sign({ userId: r.rows[0].id }, JWT_SECRET, { expiresIn: '365d' });
    res.json({ token, user: { id: r.rows[0].id, email: r.rows[0].email } });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid data', details: e.errors });
    console.error('Register error', e);
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const body = authSchema.parse(req.body);
    const email = body.email.toLowerCase();
    const rl = checkRateLimit(`login:${email}`);
    if (rl.blocked) return res.status(429).json({ error: `Too many attempts. Try again in ${rl.remainingSeconds}s.` });
    const r = await pool.query('SELECT id, email, password_hash FROM users WHERE email = $1', [email]);
    if (!r.rows.length) return res.status(401).json({ error: 'Incorrect email or password' });
    const user = r.rows[0];
    const ok = await bcrypt.compare(body.password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Incorrect email or password' });
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '365d' });
    res.json({ token, user: { id: user.id, email: user.email } });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid data', details: e.errors });
    console.error('Login error', e);
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const r = await pool.query('SELECT id, email, created_at FROM users WHERE id = $1', [req.userId]);
    if (!r.rows.length) return res.status(401).json({ error: 'Account not found' });
    res.json({ user: r.rows[0] });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

const crypto = require('crypto');

async function sendResetEmail(to, resetLink) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || 'ReceiptVault <no-reply@receiptvault.app>';
  if (!apiKey) return false;
  try {
    const body = JSON.stringify({
      from,
      to: [to],
      subject: 'ReceiptVault — Reset your password',
      html: `<p>We received a request to reset your ReceiptVault password.</p>
<p><a href="${resetLink}">Reset your password</a></p>
<p>If you didn't request this, you can safely ignore this email. This link expires in 1 hour.</p>`,
      text: `Reset your ReceiptVault password: ${resetLink}. This link expires in 1 hour. If you didn't request this, ignore this email.`,
    });
    const req = http.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
    return true;
  } catch (e) { return false; }
}

app.post('/api/auth/forgot', async (req, res) => {
  try {
    const email = z.string().email().parse((req.body || {}).email || '').toLowerCase();
    const user = await pool.query('SELECT id, email FROM users WHERE email = $1', [email]);
    if (!user.rows.length) {
      return res.json({ success: true, message: 'If that email exists, a reset link has been sent.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await pool.query(
      `INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, NOW() + INTERVAL '1 hour')`,
      [user.rows[0].id, tokenHash]
    );
    const resetLink = `${process.env.APP_URL || 'https://tfe-hub.onrender.com'}/reset?token=${token}`;
    const sent = await sendResetEmail(user.rows[0].email, resetLink);
    if (!sent) {
      console.log('RESET LINK (email not configured):', resetLink);
    }
    res.json({ success: true, message: 'If that email exists, a reset link has been sent.', devLink: sent ? undefined : resetLink });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Enter a valid email' });
    console.error('Forgot error', e);
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/auth/reset', async (req, res) => {
  try {
    const body = z.object({ token: z.string().min(20), password: z.string().min(8).max(200) }).parse(req.body);
    const strengthErrors = validatePasswordStrength(body.password);
    if (strengthErrors.length) return res.status(400).json({ error: strengthErrors.join('; ') });
    const tokenHash = crypto.createHash('sha256').update(body.token).digest('hex');
    const r = await pool.query(
      `SELECT pr.id, pr.user_id FROM password_resets pr
       WHERE pr.token_hash = $1 AND pr.used = FALSE AND pr.expires_at > NOW() LIMIT 1`,
      [tokenHash]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    const passwordHash = await bcrypt.hash(body.password, 10);
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, r.rows[0].user_id]);
    await pool.query('UPDATE password_resets SET used = TRUE WHERE id = $1', [r.rows[0].id]);
    res.json({ success: true, message: 'Password updated. You can now sign in.' });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid reset request' });
    console.error('Reset error', e);
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/upload', upload.single('receipt'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (req.file.mimetype !== 'application/pdf') {
      try {
        const sharp = require('sharp');
        await sharp(req.file.buffer).metadata();
      } catch (e) {
        return res.status(400).json({ error: 'Corrupted or invalid image file' });
      }
    }
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
    const ownerId = req.userId;

    let job;
    try {
      job = await receiptQueue.add({ filePath, originalName: req.file.originalname, profileId, projectName, isBusiness, fileHash, deviceId, ownerId });
      mesh.emit('receipt.uploaded', { jobId: String(job.id), profileId, originalName: req.file.originalname, total: req.body.total || 0 });
      res.json({ success: true, jobId: job.id, filePath, profileId });
    } catch (e) {
      console.warn('Queue unavailable, processing inline:', e.message);
      const vendor = req.file.originalname || 'unknown';
      const total = Math.floor(Math.random() * 100) + 1;
      const date = new Date().toISOString().split('T')[0];
      const insert = `INSERT INTO receipts (user_id, s3_key, vendor, date, total, items, category, status, profile_id, is_business, project_name, raw_ocr_text, currency, device_id, owner_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`;
      const values = [ownerId, filePath, vendor, date, total, JSON.stringify([]), autoCategorize(vendor), 'processed', profileId, isBusiness, projectName || null, 'inline', 'USD', deviceId, ownerId];
      const inline = await pool.query(insert, values);
      res.json({ success: true, inline: true, receiptId: inline.rows[0].id, filePath, profileId });
    }
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

    const insert = `INSERT INTO receipts (user_id, s3_key, vendor, date, total, tax_amount, items, category, status, profile_id, is_business, project_name, raw_ocr_text, currency, device_id, owner_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`;
    const values = [req.userId, source, vendor, date, total, taxAmount, JSON.stringify([]), category, 'processed', profileId, isBusiness, projectName, text, 'USD', req.deviceId, req.userId];
    const result = await pool.query(insert, values);

    const receiptId = result.rows[0].id;
    io.to(`profile:${profileId}`).emit('receipt:new', { receiptId, vendor, total, date, category });
    mesh.emit('receipt.processed', { receiptId, profileId, vendor, total, date, category, taxAmount, source: 'native-vision' });

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

    if (query.profileId) {
      sql += ` AND profile_id = $${idx++}`;
      params.push(query.profileId);
    }
    const tenant = tenantFilter(req, '', idx);
    sql += tenant.sql;
    params.push(...tenant.params);
    idx += tenant.params.length;
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
    const tenant = tenantFilter(req, '', 2);
    const r = await pool.query(`SELECT * FROM receipts WHERE id = $1${tenant.sql}`, [req.params.id, ...tenant.params]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ receipt: r.rows[0] });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/receipts/:id/image', async (req, res) => {
  try {
    const tenant = tenantFilter(req, '', 2);
    const r = await pool.query(`SELECT s3_key FROM receipts WHERE id = $1${tenant.sql}`, [req.params.id, ...tenant.params]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    const filePath = r.rows[0].s3_key;
    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'image not available' });
    }
    res.setHeader('Content-Disposition', `inline; filename="receipt-${req.params.id}"`);
    res.sendFile(path.resolve(filePath));
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
    const tenant = tenantFilter(req, '', idx + 1);
    const r = await pool.query(`UPDATE receipts SET ${sets.join(', ')} WHERE id = $${idx}${tenant.sql} RETURNING *`, [...params, ...tenant.params]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ receipt: r.rows[0] });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid fields', details: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/receipts/:id', async (req, res) => {
  try {
    const tenant = tenantFilter(req, '', 2);
    const r = await pool.query(`DELETE FROM receipts WHERE id = $1${tenant.sql} RETURNING id`, [req.params.id, ...tenant.params]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ deleted: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/profiles', async (req, res) => {
  try {
    const tenant = tenantFilter(req, '', 1);
    const r = await pool.query(`SELECT id, name, monthly_budget, created_at FROM profiles WHERE 1=1${tenant.sql} ORDER BY created_at DESC`, [...tenant.params]);
    res.json({ profiles: r.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/profiles', async (req, res) => {
  try {
    const body = createProfileSchema.parse(req.body);
    const r = await pool.query('INSERT INTO profiles (name, monthly_budget, device_id, owner_id) VALUES ($1, $2, $3, $4) RETURNING id, name, monthly_budget', [body.name, body.monthly_budget || null, req.deviceId, req.userId]);
    res.json({ profile: r.rows[0] });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid profile data', details: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

app.patch('/api/profiles/:id', async (req, res) => {
  try {
    const body = updateBudgetSchema.parse(req.body);
    const tenant = tenantFilter(req, '', 3);
    const r = await pool.query(`UPDATE profiles SET monthly_budget = $1 WHERE id = $2${tenant.sql} RETURNING id, name, monthly_budget`, [body.monthly_budget, req.params.id, ...tenant.params]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ profile: r.rows[0] });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid data', details: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/profiles/:id', async (req, res) => {
  try {
    const tenant = tenantFilter(req, '', 2);
    const r = await pool.query(`DELETE FROM profiles WHERE id = $1${tenant.sql} RETURNING id`, [req.params.id, ...tenant.params]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ deleted: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/profiles/summary', async (req, res) => {
  try {
    const tenantP = tenantFilter(req, 'p', 1);
    const tenantR = tenantFilter(req, 'r', 1);
    const r = await pool.query(`
      SELECT p.id, p.name, p.monthly_budget,
             COUNT(r.id) AS receipt_count,
             COALESCE(SUM(r.total), 0) AS total_spent,
             COALESCE(SUM(r.total) FILTER (WHERE r.date >= date_trunc('month', CURRENT_DATE)), 0) AS monthly_spent,
             MAX(r.created_at) AS latest_receipt_at
      FROM profiles p
      LEFT JOIN receipts r ON r.profile_id = p.id AND (1=1${tenantR.sql})
      WHERE 1=1${tenantP.sql}
      GROUP BY p.id, p.name, p.monthly_budget
      ORDER BY total_spent DESC, receipt_count DESC
    `, [...tenantP.params]);
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
    const tenant = tenantFilter(req, '', 2);
    const r = await pool.query(
      `SELECT id, vendor, date, total, tax_amount, category, currency, is_business, project_name, tax_category, created_at FROM receipts WHERE profile_id = $1${tenant.sql} ORDER BY created_at DESC`,
      [req.params.id, ...tenant.params]
    );
    res.json({ receipts: r.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/profiles/:id/timeseries', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 12;
    const tenant = tenantFilter(req, '', 3);
    const r = await pool.query(`
      SELECT date_trunc('month', date) AS month,
             SUM(total) AS total_spent,
             COUNT(id) AS receipt_count
      FROM receipts
      WHERE profile_id = $1 AND date >= date_trunc('month', CURRENT_DATE) - ($2 || ' months')::INTERVAL${tenant.sql}
      GROUP BY month
      ORDER BY month DESC
    `, [req.params.id, months, ...tenant.params]);
    res.json({ series: r.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/profiles/:id/export/csv', async (req, res) => {
  try {
    const tenant = tenantFilter(req, '', 2);
    const r = await pool.query(
      `SELECT id, vendor, date, total, tax_amount, category, is_business, project_name, business_notes, created_at FROM receipts WHERE profile_id = $1${tenant.sql} ORDER BY date DESC`,
      [req.params.id, ...tenant.params]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No receipts found' });
    const parser = new Parser();
    const csv = parser.parse(r.rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=receipts-${req.params.id}.csv`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/profiles/:id/export/tax', async (req, res) => {
  try {
    const tenant = tenantFilter(req, '', 2);
    const r = await pool.query(
      `SELECT id, vendor, date, total, tax_amount, category, tax_category, is_business, project_name, business_notes FROM receipts WHERE profile_id = $1${tenant.sql} ORDER BY date DESC`,
      [req.params.id, ...tenant.params]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No receipts found' });
    const rows = r.rows.map(row => ({
      Date: row.date,
      Payee: row.vendor,
      Description: row.business_notes || row.project_name || row.category || '',
      Amount: Number(row.total || 0).toFixed(2),
      'Tax Amount': row.tax_amount != null ? Number(row.tax_amount).toFixed(2) : '',
      Category: row.tax_category || row.category || 'Uncategorized',
      'Deductible': row.is_business !== false ? 'Yes' : 'No',
      'Tax Form': 'Schedule C',
    }));
    const parser = new Parser({ header: true });
    const csv = parser.parse(rows);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=receiptvault-tax-export.csv`);
    res.send(csv);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/profiles/:id/export/pdf', async (req, res) => {
  try {
    const tenant = tenantFilter(req, '', 2);
    const r = await pool.query(
      `SELECT id, vendor, date, total, tax_amount, category, is_business, project_name, business_notes, created_at FROM receipts WHERE profile_id = $1${tenant.sql} ORDER BY date DESC`,
      [req.params.id, ...tenant.params]
    );
    const profile = await pool.query('SELECT name FROM profiles WHERE id = $1', [req.params.id]);
    const profileName = profile.rows.length ? profile.rows[0].name : 'Unknown';

    const doc = new PDFDocument({ margin: 40 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=receipts-${req.params.id}.pdf`);
    doc.pipe(res);

    doc.fontSize(20).text('ReceiptVault - Receipt Report', { align: 'center' });
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
    const tenant = tenantFilter(req, '', 2);
    const r = await pool.query(`
      SELECT
        COALESCE(tax_category, 'Uncategorized') AS tax_category,
        COUNT(id) AS count,
        SUM(total) AS total_deduction
      FROM receipts
      WHERE is_business = true AND profile_id = $1${tenant.sql}
      GROUP BY tax_category
      ORDER BY total_deduction DESC
    `, [req.query.profileId, ...tenant.params]);
    const grandTotal = r.rows.reduce((acc, row) => acc + Number(row.total_deduction || 0), 0);
    res.json({ deductions: r.rows, grand_total: grandTotal });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/analytics/spending-trends', async (req, res) => {
  try {
    if (!req.query.profileId) return res.status(400).json({ error: 'profileId required' });
    const months = parseInt(req.query.months) || 6;
    const tenant = tenantFilter(req, '', 3);
    const r = await pool.query(`
      SELECT date_trunc('month', date) AS month,
             category,
             SUM(total) AS total_spent,
             COUNT(id) AS receipt_count
      FROM receipts
      WHERE profile_id = $1 AND date >= date_trunc('month', CURRENT_DATE) - ($2 || ' months')::INTERVAL${tenant.sql}
      GROUP BY month, category
      ORDER BY month DESC, total_spent DESC
    `, [req.query.profileId, months, ...tenant.params]);
    res.json({ trends: r.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/mileage', async (req, res) => {
  try {
    const profileId = req.query.profileId;
    if (!profileId) return res.status(400).json({ error: 'profileId required' });
    const tenant = tenantFilter(req, '', 2);
    const r = await pool.query(`SELECT * FROM mileage_logs WHERE profile_id = $1${tenant.sql} ORDER BY date DESC`, [profileId, ...tenant.params]);
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
      `INSERT INTO mileage_logs (profile_id, date, start_odometer, end_odometer, purpose, project_name, is_business, device_id, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [body.profile_id, body.date || new Date().toISOString().split('T')[0], body.start_odometer || null, body.end_odometer || null, body.purpose || null, body.project_name || null, body.is_business, req.deviceId, req.userId]
    );
    io.to(`profile:${body.profile_id}`).emit('mileage:new', r.rows[0]);
    mesh.emit('mileage.created', { id: r.rows[0].id, profile_id: r.rows[0].profile_id, miles: r.rows[0].miles, date: r.rows[0].date, purpose: r.rows[0].purpose });
    res.json({ mileage: r.rows[0] });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid data', details: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/mileage/:id', async (req, res) => {
  try {
    const tenant = tenantFilter(req, '', 2);
    const r = await pool.query(`DELETE FROM mileage_logs WHERE id = $1${tenant.sql} RETURNING id`, [req.params.id, ...tenant.params]);
    if (!r.rows.length) return res.status(404).json({ error: 'not found' });
    res.json({ deleted: true, id: r.rows[0].id });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/shifts/start', async (req, res) => {
  try {
    const schema = z.object({
      profile_id: z.string().uuid(),
      purpose: z.string().max(100).optional(),
    });
    const body = schema.parse(req.body);

    const active = await pool.query(
      `SELECT id, start_time FROM shifts WHERE profile_id = $1 AND status = 'active' AND (owner_id = $2 OR device_id = $3) LIMIT 1`,
      [body.profile_id, req.userId, req.deviceId]
    );
    if (active.rows.length) {
      return res.json({ shift: active.rows[0], already_active: true });
    }

    const r = await pool.query(
      `INSERT INTO shifts (profile_id, device_id, owner_id, purpose) VALUES ($1, $2, $3, $4) RETURNING *`,
      [body.profile_id, req.deviceId, req.userId, body.purpose || null]
    );
    res.json({ shift: r.rows[0] });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid data', details: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/shifts/end', async (req, res) => {
  try {
    const schema = z.object({
      shift_id: z.number().int(),
      miles: z.number().min(0).nullable().optional(),
    });
    const body = schema.parse(req.body);
    const tenant = tenantFilter(req, '', 4);
    const r = await pool.query(
      `UPDATE shifts SET end_time = $2, status = 'completed', miles = COALESCE($3, miles)
       WHERE id = $1 AND status = 'active'${tenant.sql} RETURNING *`,
      [body.shift_id, new Date(), body.miles ?? null, ...tenant.params]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'No active shift found' });
    io.to(`profile:${r.rows[0].profile_id}`).emit('shift:end', r.rows[0]);
    mesh.emit('shift.completed', { id: r.rows[0].id, profile_id: r.rows[0].profile_id, miles: r.rows[0].miles, end_time: r.rows[0].end_time, purpose: r.rows[0].purpose });
    res.json({ shift: r.rows[0] });
  } catch (e) {
    if (e instanceof z.ZodError) return res.status(400).json({ error: 'Invalid data', details: e.errors });
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/shifts/current', async (req, res) => {
  try {
    if (!req.query.profileId) return res.status(400).json({ error: 'profileId required' });
    const tenant = tenantFilter(req, '', 2);
    const r = await pool.query(
      `SELECT * FROM shifts WHERE profile_id = $1 AND status = 'active'${tenant.sql} ORDER BY start_time DESC LIMIT 1`,
      [req.query.profileId, ...tenant.params]
    );
    res.json({ shift: r.rows[0] || null });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/shifts', async (req, res) => {
  try {
    if (!req.query.profileId) return res.status(400).json({ error: 'profileId required' });
    const tenant = tenantFilter(req, '', 2);
    const r = await pool.query(
      `SELECT id, purpose, start_time, end_time, miles, status FROM shifts
       WHERE profile_id = $1${tenant.sql} ORDER BY start_time DESC LIMIT 30`,
      [req.query.profileId, ...tenant.params]
    );
    res.json({ shifts: r.rows });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/daily-summary', async (req, res) => {
  try {
    if (!req.query.profileId) return res.status(400).json({ error: 'profileId required' });

    const tenantR = tenantFilter(req, 'r', 2);
    const tenantS = tenantFilter(req, 's', 2);

    const today = await pool.query(
      `SELECT
         COALESCE(SUM(r.total), 0) AS spend,
         COUNT(r.id) AS receipts,
         COALESCE(SUM(r.total) FILTER (WHERE r.is_business), 0) AS business_spend
       FROM receipts r
       WHERE r.profile_id = $1 AND r.date = CURRENT_DATE${tenantR.sql}`,
      [req.query.profileId, ...tenantR.params]
    );
    const miles = await pool.query(
      `SELECT COALESCE(SUM(s.miles), 0) AS miles, COUNT(*) AS shifts
       FROM shifts s WHERE s.profile_id = $1 AND s.status = 'completed' AND s.end_time >= date_trunc('day', CURRENT_DATE)${tenantS.sql}`,
      [req.query.profileId, ...tenantS.params]
    );

    res.json({
      today: {
        spend: Number(today.rows[0].spend),
        business_spend: Number(today.rows[0].business_spend),
        receipts: Number(today.rows[0].receipts),
        miles: Number(miles.rows[0].miles),
        shifts: Number(miles.rows[0].shifts),
      },
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/projects', async (req, res) => {
  try {
    const profileId = req.query.profileId;
    if (!profileId) return res.status(400).json({ error: 'profileId required' });
    const tenant = tenantFilter(req, '', 2);
    const r = await pool.query(`SELECT * FROM projects WHERE profile_id = $1${tenant.sql} ORDER BY name`, [profileId, ...tenant.params]);
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
    const r = await pool.query('INSERT INTO projects (name, profile_id, description, device_id, owner_id) VALUES ($1, $2, $3, $4, $5) RETURNING *', [body.name, body.profile_id, body.description || null, req.deviceId, req.userId]);
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

// ---- Genie Mesh: persistent JARV-Genie link + agentic REST gateway ----
app.set('genie:io', io);
app.use('/api/genie', genieMesh.createGenieApi({ pool, mesh, rateLimit: checkRateLimit, log: console }));
genieMesh.attachInboundSocket({ io, mesh, pool, log: console });

app.get('/api/comms/status', async (req, res) => {
  try {
    if (!req.userId && !req.deviceId) return res.status(401).json({ error: 'authenticate to view comms status' });
    const status = await mesh.getStatus();
    status.telegram = telegram ? telegram.getStatus() : { enabled: false, error: 'TELEGRAM_BOT_TOKEN not set' };
    res.json({ mesh: status });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/comms/telegram', (req, res) => {
  if (!telegram) return res.status(501).json({ enabled: false, error: 'TELEGRAM_BOT_TOKEN not set' });
  res.json({ telegram: telegram.getStatus() });
});

// ---- OSINT for the app: JARV satellite-comms intelligence under regular auth ----
const OSINT_SATVISION_PARAMS = ['lat', 'lon', 'alt', 'satellites', 'passes', 'min_el', 'overhead', 'footprint'];

// ---- OSINT quick-query prefs: remember the operator's last scan params ----
const OSINT_PREFS_FILE = path.resolve(__dirname, '..', 'data', 'osint-prefs.json');
function loadOsintPrefs() {
  try { return JSON.parse(fs.readFileSync(OSINT_PREFS_FILE, 'utf8')) || {}; } catch (e) { return {}; }
}
function saveOsintPrefs(prefs) {
  try {
    fs.mkdirSync(path.dirname(OSINT_PREFS_FILE), { recursive: true });
    fs.writeFileSync(OSINT_PREFS_FILE, JSON.stringify(prefs, null, 2));
  } catch (e) { /* non-fatal */ }
}
function applyOsintPrefs(args) {
  const p = loadOsintPrefs();
  const out = { ...args };
  if (out.satellites == null || !String(out.satellites).trim()) out.satellites = p.groups || 'starlink,oneweb,iridium-next,gps';
  if (out.passes == null && p.passes != null) out.passes = p.passes;
  if (out.min_el == null && p.min_el != null) out.min_el = p.min_el;
  return out;
}
function persistOsintPrefs(args) {
  const p = loadOsintPrefs();
  if (args.satellites) p.groups = String(args.satellites).replace(/\s+/g, '').split(',').filter(Boolean).slice(0, 12).join(',');
  if (args.passes != null) p.passes = Number(args.passes);
  if (args.min_el != null) p.min_el = Number(args.min_el);
  p.lastScanAt = new Date().toISOString();
  saveOsintPrefs(p);
  return p;
}
app.use('/api/osint', (req, res, next) => {
  if (!req.userId && !req.deviceId) return res.status(401).json({ error: 'authenticate to use OSINT' });
  next();
});
app.get('/api/osint/handbook', async (req, res) => {
  try {
    const out = await jarv.executeTool('jarv_osint_handbook', {});
    if (!out.ok) return res.status(500).json({ error: out.error || 'handbook unavailable' });
    res.json({ handbook: out.content, source: out.source });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.get('/api/osint/policy', async (req, res) => {
  try {
    res.json(jarv.getPolicy ? jarv.getPolicy() : { error: 'policy unavailable' });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.get('/api/osint/prefs', async (req, res) => {
  if (!req.userId && !req.deviceId) return res.status(401).json({ error: 'authenticate to use OSINT' });
  try { return res.json({ ok: true, prefs: loadOsintPrefs() }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/osint/prefs', async (req, res) => {
  if (!req.userId && !req.deviceId) return res.status(401).json({ error: 'authenticate to use OSINT' });
  try {
    const patch = ((req.body || {}).prefs) || {};
    const p = { ...loadOsintPrefs(), ...patch };
    if (p.groups) p.groups = String(p.groups).replace(/\s+/g, '').split(',').filter(Boolean).slice(0, 12).join(',');
    saveOsintPrefs(p);
    return res.json({ ok: true, prefs: loadOsintPrefs() });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.get('/api/osint/satvision', async (req, res) => {
  try {
    const args = {};
    for (const p of OSINT_SATVISION_PARAMS) if (req.query[p] !== undefined) args[p] = req.query[p];
    const filled = applyOsintPrefs(args);
    const out = await jarv.executeTool('jarv_satvision', filled);
    if (out && out.ok) persistOsintPrefs(filled);
    return res.json(out);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/osint/satvision', async (req, res) => {
  try {
    const body = (req.body || {});
    const args = {};
    for (const p of OSINT_SATVISION_PARAMS) if (body[p] !== undefined) args[p] = body[p];
    const filled = applyOsintPrefs(args);
    const out = await jarv.executeTool('jarv_satvision', filled);
    if (out && out.ok) persistOsintPrefs(filled);
    return res.json(out);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Global projection of the OSINT catalog: every loaded satellite's current
// subpoint (lat/lon/alt) for 3D globe rendering (Babylon).
app.get('/api/osint/globe', async (req, res) => {
  try {
    const defaultGroups = loadOsintPrefs().groups || 'starlink,oneweb,iridium-next,gps';
    const groups = String(req.query.satellites || defaultGroups).replace(/\s+/g, '');
    const filled = { satellites: groups };
    const out = await jarv.executeTool('jarv_globe', filled);
    if (out && out.ok) persistOsintPrefs(filled);
    return res.json(out);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---- JARV command-center chat (browser-facing, under regular auth) ----
app.post('/api/jarv/chat', async (req, res) => {
  if (!req.userId && !req.deviceId) return res.status(401).json({ error: 'authenticate to talk to JARV' });
  const agentKey = req.userId ? ('u:' + req.userId) : ('d:' + (req.deviceId || 'anon'));
  const rl = checkAgentRate(agentKey);
  if (!rl.ok) return res.status(429).json({ error: rl.reason, retryAfter: rl.retryAfter });
  agentBusy(agentKey, true);
  try {
    const body = (req.body || {});
    const input = body.message;
    let history = (body.history || []).filter((m) => m && ['user', 'assistant'].includes(m.role));
    if (!input || typeof input !== 'string' || !input.trim()) {
      return res.status(400).json({ error: 'message required' });
    }
    // Overload caps: a "text bomb" can only carry up to 8KB of new text and a
    // bounded history; nothing beyond that can bloat the model context.
    history = history.slice(-24);
    const historyChars = history.reduce((n, m) => n + String(m.content || '').length, 0);
    if (historyChars > 60000) history = history.slice(0, 0); // lethal-size histories discarded
    if (history.length) {
      history.push({ role: 'user', content: String(input).slice(0, 8000) });
    }
    const maxTokens = Math.min(Math.max(Number(body.max_tokens) || 900, 64), 4096);
    const out = await jarv.ask(history.length ? history : input, {
      max_tokens: maxTokens,
      model: body.model || undefined,
      budgetMs: 240000,
    });
    if (!out || !out.ok) return res.status(500).json({ error: (out && out.error) || 'JARV relay failed' });
    return res.json({
      ok: true,
      reply: out.reply,
      provider: out.provider || 'jarv-mesh',
      model: out.model || null,
      turns: out.turns || 1,
      toolCalls: mapToolCalls(out),
      blocked: out.blocked || [],
    });
  } catch (e) {
    const msg = String((e && e.message) || e);
    res.status(500).json({ error: /JARV_POLICY_BLOCK/.test(msg) ? msg : `JARV relay error: ${msg}` });
  } finally {
    agentBusy(agentKey, false);
  }
});

// ---- JARV CLI + Code editor (browser-facing, under regular auth) ----
// ---- JARV operator approvals (allow once / allow in session / allow all) ----
const jarvApprovals = new Map(); // key -> { tools:Set, shell:bool, net:bool, until:ms }
const APPROVAL_TTL_MS = 8 * 60 * 60 * 1000; // 8-hour session approval

function approvalKey(req) { return req.userId ? ('u:' + req.userId) : ('d:' + (req.deviceId || 'anon')); }

function approvalSession(req) {
  const key = approvalKey(req);
  let s = jarvApprovals.get(key);
  if (!s || s.until <= Date.now()) {
    s = { tools: new Set(), shell: false, net: false, until: Date.now() + APPROVAL_TTL_MS };
    jarvApprovals.set(key, s);
  }
  return s;
}

function grantApproval(req, mode, sess) {
  const s = sess || approvalSession(req);
  if (mode === 'session') {
    ['jarv_write', 'jarv_edit', 'jarv_run'].forEach((t) => s.tools.add(t));
    s.shell = true;
    s.net = true;
  } else if (mode === 'all') {
    const upd = { JARV_AUTONOMOUS_SHELL: '1', JARV_AUTONOMOUS_NET: '1' };
    try { aiKeys.upsertEnv(upd); } catch (e) { /* non-fatal */ }
    process.env.JARV_AUTONOMOUS_SHELL = '1';
    process.env.JARV_AUTONOMOUS_NET = '1';
    ['jarv_write', 'jarv_edit', 'jarv_run'].forEach((t) => s.tools.add(t));
    s.shell = true;
    s.net = true;
  }
  return s;
}

function shellAllowed(req, sess, once) {
  return !!(once || process.env.JARV_AUTONOMOUS_SHELL === '1' || sess.shell);
}

function netAllowed(req, sess, once) {
  return !!(once || process.env.JARV_AUTONOMOUS_NET === '1' || sess.net);
}

// Casual-paced SSE reveal for the Code Forge. The agent work (tool calls, edits)
// already finished server-side before this runs, so pacing the text is purely
// cosmetic — it can't interrupt an edit mid-write. ~42 chars / 52ms keeps the
// feel alive without hammering the event loop or the browser.
function sendSse(res, obj) {
  if (res.writableEnded || res.destroyed) return;
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {}
}
// Empirical tool audit: emit what the hands ACTUALLY returned (already redacted +
// framed as untrusted data by jarvAgent) alongside the agent's narration, so an
// operator can diff claim vs ground truth. No result => the call had none (e.g.
// "see"), not a hallucinated value.
function mapToolCalls(out) {
  const ser = (v) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'string') return v.slice(0, 4000);
    try { return JSON.stringify(v).slice(0, 4000); } catch (e) { return String(v).slice(0, 4000); }
  };
  return (out.toolCalls || []).map((t) => {
    const x = { name: t.name, args: t.args };
    if (t.result !== undefined && t.result !== null) x.result = ser(t.result);
    if (t.err !== undefined && t.err !== null) x.err = ser(t.err);
    return x;
  });
}
function pumpSse(res, text) {
  const CHUNK = 42;
  const GAP = 52;
  return new Promise((resolve) => {
    let at = 0;
    const step = () => {
      if (res.writableEnded || res.destroyed) return resolve(true);
      if (at >= text.length) return resolve(true);
      sendSse(res, { type: 'chunk', text: text.slice(at, at + CHUNK) });
      at += CHUNK;
      setTimeout(step, GAP);
    };
    step();
  });
}

app.get('/api/jarv/workspace', async (req, res) => {
  if (!req.userId && !req.deviceId) return res.status(401).json({ error: 'authenticate first' });
  try {
    const caps = await jarv.getCapabilities();
    const sess = approvalSession(req);
    return res.json({
      ok: true,
      sandboxRoot: caps.sandboxRoot,
      policy: caps.policy,
      autonomousShell: process.env.JARV_AUTONOMOUS_SHELL === '1',
      autonomousNet: process.env.JARV_AUTONOMOUS_NET === '1',
      sessionShell: sess.shell,
      sessionNet: sess.net,
      sessionTools: [...sess.tools],
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/settings/autonomy', async (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'authenticate first' });
  try {
    const b = (req.body || {});
    const updates = {};
    if (typeof b.shell === 'boolean') updates.JARV_AUTONOMOUS_SHELL = b.shell ? '1' : '0';
    if (typeof b.net === 'boolean') updates.JARV_AUTONOMOUS_NET = b.net ? '1' : '0';
    if (Object.keys(updates).length) {
      try { aiKeys.upsertEnv(updates); } catch (e) { /* non-fatal */ }
      for (const [k, v] of Object.entries(updates)) { if (v === '1') process.env[k] = '1'; else delete process.env[k]; }
    }
    if (b.resetSession) jarvApprovals.delete(approvalKey(req));
    const sess = approvalSession(req);
    return res.json({ ok: true, autonomousShell: process.env.JARV_AUTONOMOUS_SHELL === '1', autonomousNet: process.env.JARV_AUTONOMOUS_NET === '1', sessionShell: sess.shell, sessionNet: sess.net });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---- Mac permissions: verify JARV's hands are granted (TCC) ----
// GET = quick status read; POST with {deep:true} also runs a screen-capture +
// OCR sanity pass so the dashboard can prove the full see/click pipeline works.
app.get('/api/jarv/permissions', async (req, res) => {
  if (!req.userId && !req.deviceId) return res.status(401).json({ error: 'authenticate first' });
  try {
    const out = await jarv.executeTool('jarv_run', { command: 'jarv-drive status' });
    const text = (out && out.stdout) ? String(out.stdout) : ((out && out.error) ? `error: ${out.error}` : 'no output');
    return res.json({
      ok: true,
      axTrusted: /\baxTrusted:\s*(true|yes|1)\b/i.test(text),
      frontmost: ((text.match(/frontmost:\s*([^\s,)]+)/) || [])[1] || null),
      screen: ((text.match(/main:\s*([^\s]+)/) || [])[1] || null),
      raw: text.slice(0, 400),
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/jarv/permissions', async (req, res) => {
  if (!req.userId && !req.deviceId) return res.status(401).json({ error: 'authenticate first' });
  try {
    const statusOut = await jarv.executeTool('jarv_run', { command: 'jarv-drive status' });
    const text = (statusOut && statusOut.stdout) ? String(statusOut.stdout) : '';
    let ocr = { ok: false, rows: 0, sample: '' };
    if ((req.body || {}).deep) {
      const seeOut = await jarv.executeTool('jarv_run', { command: 'jarv-drive see' });
      const seeRaw = (seeOut && seeOut.stdout) ? String(seeOut.stdout) : '';
      const rows = seeRaw.split('\n').filter((l) => l.trim() && !/^(--?|\s*processing|picture saved|ocr digest)/i.test(l.trim()));
      ocr = { ok: rows.length > 0, rows: rows.length, sample: rows.slice(0, 6).join(' · ').slice(0, 220), raw: seeRaw.slice(0, 600) };
    }
    return res.json({
      ok: true,
      axTrusted: /\baxTrusted:\s*(true|yes|1)\b/i.test(text),
      frontmost: ((text.match(/frontmost:\s*([^\s,)]+)/) || [])[1] || null),
      screen: ((text.match(/main:\s*([^\s]+)/) || [])[1] || null),
      ocr,
      raw: text.slice(0, 400),
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/jarv/cli', async (req, res) => {
  if (!req.userId && !req.deviceId) return res.status(401).json({ error: 'authenticate to use the JARV terminal' });
  const agentKey = req.userId ? ('u:' + req.userId) : ('d:' + (req.deviceId || 'anon'));
  const rl = checkAgentRate(agentKey);
  if (!rl.ok) return res.status(429).json({ error: rl.reason, retryAfter: rl.retryAfter });
  agentBusy(agentKey, true);
  try {
    const body = (req.body || {});
    const line = String(body.command || '').trim();
    if (!line) return res.status(400).json({ error: 'command required' });
    const session = approvalSession(req);
    const once = body.unlock === true || body.approval === 'once';
    grantApproval(req, body.approval, session);
    const approvedShell = shellAllowed(req, session, once);
    const approvedNet = netAllowed(req, session, once);
    const toolsUnlocked = new Set(['jarv_write', 'jarv_edit', 'jarv_run'].filter((t) => once || approvedShell || session.tools.has(t)));

    const first = line.split(/\s+/)[0];
    const toolMatch = line.match(/^(\S+)\s+(.+)$/);
    const hasTool = jarv.getToolDefs && jarv.getToolDefs().some((t) => t.name === first);
    if (hasTool) {
      const name = first;
      const argStr = toolMatch ? toolMatch[2] : '';
      let args = {};
      if (argStr) {
        try {
          args = JSON.parse(argStr);
        } catch (e) {
          if (name.startsWith('jarv_write')) { const i = argStr.indexOf(' '); args = { path: (i > 0 ? argStr.slice(0, i) : argStr).trim(), content: i > 0 ? argStr.slice(i + 1) : '' }; }
          else if (name.startsWith('jarv_edit')) { const p = argStr.split('|'); args = { path: (p[0] || '').trim(), search: p[1] || '', replace: p[2] || '' }; }
          else if (name.startsWith('jarv_run')) args = { command: argStr };
          else args = { path: argStr };
        }
      }
      if ((name.startsWith('jarv_satvision') || name.startsWith('jarv_globe')) && !args.satellites) args.satellites = 'starlink,oneweb,iridium-next,gps';
      let out;
      if ((name === 'jarv_run' || name === 'jarv_write' || name === 'jarv_edit') && !toolsUnlocked.has(name)) {
        out = { ok: false, error: `JARV_POLICY_BLOCK: ${name} needs operator approval. Re-run it with approval 'once', 'session' or 'all' (or tick "approve write/edit/run").` };
      } else {
        out = await jarv.executeTool(name, args);
      }
      if (out && out.ok === false && /JARV_POLICY_BLOCK/.test(out.error || '')) {
        return res.json({ ok: false, tool: name, blocked: [{ name, args, reason: 'requires-operator-approval' }], needsApproval: [{ name, args, reason: 'requires-operator-approval' }], error: out.error });
      }
      return res.json(Object.assign({ ok: !!out.ok, tool: name, command: line }, out || {}, { blocked: false }));
    }

    const out = await jarv.ask(line, {
      max_tokens: body.max_tokens || 1200,
      model: body.model || undefined,
      unlock: toolsUnlocked.size ? [...toolsUnlocked] : [],
      allowShell: approvedShell,
      allowNet: approvedNet,
    });
    if (body.stream === true) {
      res.status(200);
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      const blocked = out.blocked || [];
      sendSse(res, { type: 'start' });
      if (blocked.length && !once && !session.tools.size && !approvedShell) {
        sendSse(res, {
          type: 'approval',
          reply: out.reply || '',
          needsApproval: blocked.map((b) => ({ name: b.name, args: b.args, reason: b.reason })),
        });
        try { res.end(); } catch (e) {}
        return;
      }
      await pumpSse(res, String(out.reply || ''));
      sendSse(res, {
        type: 'done',
        ok: out.ok,
        provider: out.provider,
        model: out.model,
        turns: out.turns,
        toolCalls: mapToolCalls(out),
        blocked,
        error: out.error,
      });
      try { res.end(); } catch (e) {}
      return;
    }
    const blocked = out.blocked || [];
    if (blocked.length && !once && !session.tools.size && !approvedShell) {
      return res.json({
        ok: out.ok, reply: out.reply, provider: out.provider, model: out.model, turns: out.turns,
        toolCalls: mapToolCalls(out),
        blocked,
        needsApproval: blocked.map((b) => ({ name: b.name, args: b.args, reason: b.reason })),
        approval: 'pending',
      });
    }
    return res.json({ ok: out.ok, reply: out.reply, provider: out.provider, model: out.model, turns: out.turns, toolCalls: mapToolCalls(out), blocked, error: out.error });
  } catch (e) {
    const msg = String((e && e.message) || e);
    res.status(500).json({ error: /JARV_POLICY_BLOCK/.test(msg) ? msg : `JARV terminal error: ${msg}` });
  } finally {
    agentBusy(agentKey, false);
  }
});

// ---- JARV Code editor (structured IDE endpoints for the sandbox) ----
app.get('/api/jarv/code/list', async (req, res) => {
  if (!req.userId && !req.deviceId) return res.status(401).json({ error: 'authenticate first' });
  try { return res.json(await jarv.listDir(req.query.path || '')); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.get('/api/jarv/code/read', async (req, res) => {
  if (!req.userId && !req.deviceId) return res.status(401).json({ error: 'authenticate first' });
  try { return res.json(await jarv.readFile(req.query.path || '')); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/jarv/code/write', async (req, res) => {
  if (!req.userId && !req.deviceId) return res.status(401).json({ error: 'authenticate first' });
  try { const b = req.body || {}; return res.json(await jarv.writeFile(b.path, b.content)); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/jarv/code/edit', async (req, res) => {
  if (!req.userId && !req.deviceId) return res.status(401).json({ error: 'authenticate first' });
  try { const b = req.body || {}; const out = await jarv.fileEdit(b.path, b.search, b.replace); return res.json({ ok: !!out.ok, error: out.error, path: b.path }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/jarv/code/run', async (req, res) => {
  if (!req.userId && !req.deviceId) return res.status(401).json({ error: 'authenticate first' });
  try {
    const b = req.body || {};
    const line = String(b.command || '').trim();
    if (!line) return res.status(400).json({ error: 'command required' });
    if (jarv.isBlocked && jarv.isBlocked(line)) return res.json({ ok: false, error: 'JARV_POLICY_BLOCK: command blocked by JARV safety blocklist' });
    return res.json(await jarv.execAllowlist(line));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.get('/api/jarv/code/root', async (req, res) => {
  if (!req.userId && !req.deviceId) return res.status(401).json({ error: 'authenticate first' });
  try { const caps = await jarv.getCapabilities(); return res.json({ ok: true, sandboxRoot: caps.sandboxRoot, policy: caps.policy }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.get('/api/jarv/code/tools', async (req, res) => {
  if (!req.userId && !req.deviceId) return res.status(401).json({ error: 'authenticate first' });
  try { return res.json({ ok: true, tools: jarv.getToolDefs() }); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---- JARV MCP (Model Context Protocol) — SSE server for AI coding tools ----
const mcpSessions = new Map();
const mcpSse = jarvMcp.makeSseHandler({ jarv, log: console, sessions: mcpSessions });
app.get('/api/jarv/mcp', (req, res) => { mcpSse.get(req, res).catch((e) => { if (!res.headersSent) res.status(500).end(String(e && e.message || e)); }); });
app.post('/api/jarv/mcp', (req, res) => { mcpSse.post(req, res).catch((e) => { if (!res.headersSent) res.status(500).end(String(e && e.message || e)); }); });
app.get('/api/jarv/mcp/info', (req, res) => {
  res.json({ name: 'fortress-hub-jarv', version: '1.0.0', transport: 'sse', tools: jarv.getToolDefs().map((t) => t.name), connect: `${req.protocol}://${req.get('host')}/api/jarv/mcp` });
});

// ---- Settings: cloud API key management (requires a logged-in user) ----
app.get('/api/ai/providers', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'authenticate first' });
  try {
    const chain = ai.getStatus().providers || [];
    return res.json({ ok: true, providers: aiKeys.listKeys(chain) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/ai/keys', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'authenticate first' });
  try {
    const chain = ai.getStatus().providers || [];
    const out = aiKeys.saveKeys((req.body && req.body.keys) || {}, chain);
    return res.json({ ok: true, ...out });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ---- Hub location services (family grid fix) ----
app.get('/api/location', async (req, res) => {
  try { return res.json(await locService.getCurrent()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.get('/api/location/devices', async (req, res) => {
  try { return res.json(await locService.getDevices()); }
  catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/location/report', async (req, res) => {
  try {
    const b = (req.body || {});
    const out = await locService.report({ lat: b.lat, lon: b.lon, accuracy_m: b.accuracy, source: b.source || 'device', deviceId: req.deviceId || `web-${Date.now()}` });
    return res.json(out);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});
app.post('/api/location/manual', async (req, res) => {
  try {
    const b = (req.body || {});
    const out = await locService.setManual({ lat: b.lat, lon: b.lon, accuracy_m: b.accuracy });
    return res.json(out);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Fire-and-forget TLE warm-up. Uses the same cache rules as jarv-satvision.py
// (CACHE_FRESH_SECS = 2h): only fetch when the store is absent or stale, and do
// it via `--positions` (loads the groups, refreshing their TLE) without an
// observer. Empirically driven: the decision comes from the cache file's own
// mtime, not a guess about freshness.
function warmTleCache() {
  try {
    const BACKEND_DIR = path.resolve(__dirname, '..');
    const cacheFile = path.join(BACKEND_DIR, '..', 'jarv-sandbox', 'tmp', 'tle-cache.json');
    const CACHE_FRESH_SECS = 2 * 3600;
    let stale = true;
    try {
      const st = fs.statSync(cacheFile);
      stale = Date.now() - st.mtimeMs > CACHE_FRESH_SECS * 1000;
      if (!stale) { console.log('[tle-warm] cache is fresh — skipping pre-warm'); return; }
    } catch (e) { /* no cache file yet */ }
    const prefs = loadOsintPrefs();
    const groups = (prefs.groups || 'starlink,oneweb,iridium-next,gps').split(',').map((s) => s.trim()).filter(Boolean).join(',');
    console.log(`[tle-warm] TLE cache missing/stale — background refresh of [${groups}]…`);
    const { execFile } = require('child_process');
    const child = execFile('python3', ['jarv-satvision.py', '--positions', '--satellites', groups, '--json'], {
      cwd: BACKEND_DIR, timeout: 180000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, PYTHONUNBUFFERED: '1' },
    }, (err, stdout) => {
      if (err) { console.log('[tle-warm] failed:', String(err.message || err).slice(0, 300)); return; }
      try {
        const j = JSON.parse(stdout);
        console.log(`[tle-warm] done — ${(j.positions || []).length} sats warmed (${groups})`);
      } catch (e) { console.log('[tle-warm] done (unparsed output)'); }
    });
    child.on('error', (e) => console.log('[tle-warm] spawn error:', String(e).slice(0, 300)));
    child.unref();
  } catch (e) {
    console.log('[tle-warm] skipped:', String((e && e.message) || e).slice(0, 300));
  }
}

function detectTailscaleIp() {
  try {
    const out = require('child_process').execFileSync('tailscale', ['ip', '-4'], { timeout: 1500, encoding: 'utf8' });
    return (out || '').trim().split('\n')[0] || null;
  } catch (e) { return null; }
}

// Kick off the mesh (seeds the peer row, launches outbound socket + flusher),
// the AI relay (Free DeepSeek V4 processing loop) and the Telegram tunnel.
mesh.start().catch(e => console.error('[genie-mesh] failed to start:', e));
ai.start();
if (telegram) telegram.start().catch(e => console.error('[telegram] failed to start:', e));

server.listen(PORT, HOST, () => {
  console.log(`Backend listening on http://${HOST === '0.0.0.0' ? require('os').hostname() : HOST}:${PORT}`);
  const tsIp = detectTailscaleIp();
  if (tsIp) console.log(`Tailscale:  http://${tsIp}:${PORT}  (tailnet-only; JARV_GENIE_URL can point here or at your ts.net name)`);
  if (telegram) console.log('Telegram tunnel: enabled (long-poll, no inbound ports)');
  console.log(`[jarv] env: JARV_CHAT_LOCAL=${process.env.JARV_CHAT_LOCAL ?? '<unset>'} | autonomousShell=${process.env.JARV_AUTONOMOUS_SHELL ?? '<unset>'} | autonomousNet=${process.env.JARV_AUTONOMOUS_NET ?? '<unset>'} | autonomousWrite=${process.env.JARV_AUTONOMOUS_WRITE ?? '<unset>'}`);

  // Empirical provider inventory: what the mesh can ACTUALLY reach right now,
  // from its resolved key set — not from what .env.example promises.
  void (async () => {
    try {
      const st = await ai.getStatus();
      const keyed = (st.providers || []).filter((n) => n !== 'ollama-local' && n !== 'pollinations');
      const live = Object.keys(st.providerHealth || {}).filter((n) => st.providerHealth[n] && st.providerHealth[n].ok);
      console.log(`[mesh] enabled=${st.enabled} tier=${st.tier} chain=[${(st.providers || []).join(', ')}] live=[${live.join(', ')}] keyed=${keyed.length} last=${st.lastProviderUsed || 'none'}`);
      if (!keyed.length && !st.enabled) console.log('[mesh] no usable provider chain — set OPENCODE_API_KEY, OPENROUTER_API_KEY, GROQ_API_KEY or another mesh key, or start Ollama locally.');
    } catch (e) { console.log('[mesh] inventory unavailable:', String((e && e.message) || e)); }
  })();

  // Idle TLE pre-warm: when the on-disk TLE cache is missing or older than the
  // refresh window, fetch the default OSINT groups in the background so the
  // first God's Eye / quick-scan call is served from a warm cache. Non-blocking;
  // failures are logged, never fatal.
  warmTleCache();
});

function shutdown(signal) {
  console.log(`\n[server] ${signal} — draining mesh, AI relay and Telegram tunnel, then exiting.`);
  try { mesh.stop(); } catch (e) { /* ignore */ }
  try { ai.stop(); } catch (e) { /* ignore */ }
  if (telegram) { try { telegram.stop(); } catch (e) { /* ignore */ } }
  setTimeout(() => process.exit(0), 400).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

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
