const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { db, getSetting, setSetting, deleteSetting, UPLOAD_DIR } = require('./db');
const yoco = require('./yoco');
const { currentCompetition, drawWinner } = require('./orders');
const {
  httpError,
  safeEqual,
  publicUrl,
  randsToCents,
  ticketNo,
  customerNo,
  parseCustomerNo,
  hashToken,
  readCookie,
  hashPassword,
  verifyPassword,
  checkNewPassword,
  loginLimiter,
  isLocalRequest,
} = require('./util');

const router = express.Router();

// ---------------------------------------------------------------- admin password & sessions

const COOKIE = 'wb_admin';
const SESSION_MS = 12 * 3600 * 1000;
const limiter = loginLimiter();
const adminPasswordHash = () => getSetting('admin_password_hash');

// Before an admin password exists, anyone opening /admin from another computer must enter this
// one-time code from the server log, so a stranger can't claim the admin panel first.
let setupCode = null;
function getSetupCode() {
  if (!setupCode) {
    setupCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    console.log(`  Admin setup code (only needed when setting up from another computer): ${setupCode}`);
  }
  return setupCode;
}

function startAdminSession(req, res) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, expires_at) VALUES (?, ?)').run(hashToken(token), Date.now() + SESSION_MS);
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: SESSION_MS, path: '/' });
}

router.get('/setup', (req, res) => {
  const needsSetup = !adminPasswordHash();
  const needsCode = needsSetup && !isLocalRequest(req);
  if (needsCode) getSetupCode();
  res.json({ needsSetup, needsCode });
});

router.post('/setup', async (req, res) => {
  if (adminPasswordHash()) throw httpError(400, 'The admin password has already been created. Please log in.');
  limiter.check(req.ip);
  if (!isLocalRequest(req) && !safeEqual(String(req.body?.code || '').trim().toUpperCase(), getSetupCode())) {
    limiter.fail(req.ip);
    throw httpError(401, 'Wrong setup code. Look for "Admin setup code" in the server log.');
  }
  checkNewPassword(req.body?.password);
  const hash = await hashPassword(req.body.password);
  if (adminPasswordHash()) throw httpError(400, 'The admin password has already been created. Please log in.');
  setSetting('admin_password_hash', hash);
  setupCode = null;
  startAdminSession(req, res);
  res.json({ ok: true });
});

router.post('/login', async (req, res) => {
  limiter.check(req.ip);
  const hash = adminPasswordHash();
  if (!hash) throw httpError(409, 'No admin password has been created yet. Please refresh the page.');
  if (!(await verifyPassword(String(req.body?.password ?? ''), hash))) {
    limiter.fail(req.ip);
    throw httpError(401, 'Wrong password.');
  }
  limiter.clear(req.ip);
  startAdminSession(req, res);
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

// Everything below requires a logged-in admin.
router.use((req, res, next) => {
  const token = readCookie(req, COOKIE);
  const session = token && db.prepare('SELECT expires_at FROM sessions WHERE token_hash = ?').get(hashToken(token));
  if (!session || session.expires_at < Date.now()) throw httpError(401, 'Please log in.');
  next();
});

router.get('/me', (req, res) => res.json({ ok: true }));

router.put('/password', async (req, res) => {
  if (!(await verifyPassword(String(req.body?.current || ''), adminPasswordHash()))) {
    throw httpError(400, 'Your current password is wrong.');
  }
  checkNewPassword(req.body?.password);
  setSetting('admin_password_hash', await hashPassword(req.body.password));
  // Log out every other admin session.
  db.prepare('DELETE FROM sessions WHERE token_hash != ?').run(hashToken(readCookie(req, COOKIE)));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- helpers

const competitionStats = db.prepare(`
  SELECT
    (SELECT COUNT(*) FROM entries WHERE competition_id = @id) AS entries,
    (SELECT COUNT(*) FROM orders WHERE competition_id = @id AND status = 'paid') AS paid_orders,
    (SELECT COALESCE(SUM(amount_cents), 0) FROM orders WHERE competition_id = @id AND status = 'paid') AS revenue_cents,
    (SELECT COUNT(*) FROM orders WHERE competition_id = @id) AS all_orders
`);

// draft | scheduled | live | ended | closed | drawn
function phaseOf(c) {
  if (c.status !== 'active') return c.status;
  const now = new Date().toISOString();
  if (c.starts_at > now) return 'scheduled';
  return c.draw_at > now ? 'live' : 'ended';
}

function withStats(c) {
  return {
    ...c,
    phase: phaseOf(c),
    image_url: c.image_path ? `/uploads/${c.image_path}` : null,
    ...competitionStats.get({ id: c.id }),
  };
}

function listOrders({ competition, status, q, limit = 500 } = {}) {
  const where = [];
  const params = { limit };
  if (competition) {
    where.push('o.competition_id = @competition');
    params.competition = Number(competition);
  }
  if (status) {
    where.push('o.status = @status');
    params.status = String(status);
  }
  if (q) {
    // Matches name/email/phone, an order number, a ticket number (WB000123) or a customer ID (WBC-00042).
    where.push(`(o.name LIKE @q OR o.email LIKE @q OR o.phone LIKE @q OR o.id = @num OR o.user_id = @customer
                 OR EXISTS (SELECT 1 FROM entries e WHERE e.order_id = o.id AND e.id = @num))`);
    params.q = `%${String(q).trim()}%`;
    params.customer = parseCustomerNo(q);
    params.num = params.customer > 0 ? -1 : Number(String(q).replace(/\D/g, '')) || -1;
  }
  return db
    .prepare(
      `SELECT o.id, o.user_id, o.created_at, o.paid_at, o.name, o.email, o.phone, o.amount_cents, o.base_entries,
              o.bonus_entries, o.spun, o.status, o.competition_id, c.title AS competition_title,
              (SELECT GROUP_CONCAT(e.id) FROM entries e WHERE e.order_id = o.id) AS entry_ids
       FROM orders o JOIN competitions c ON c.id = o.competition_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY o.id DESC LIMIT @limit`
    )
    .all(params)
    .map(({ entry_ids, ...o }) => ({
      ...o,
      customer_no: customerNo(o.user_id),
      tickets: entry_ids ? entry_ids.split(',').map((id) => ticketNo(Number(id))) : [],
    }));
}

function sendCsv(res, filename, header, rows) {
  const cell = (value) => {
    let s = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stop spreadsheet formula injection
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header, ...rows].map((row) => row.map(cell).join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + lines.join('\r\n'));
}

// ---------------------------------------------------------------- dashboard

router.get('/stats', (req, res) => {
  const totals = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'paid' THEN amount_cents END), 0) AS revenue_cents,
         COUNT(CASE WHEN status = 'paid' THEN 1 END) AS paid_orders,
         COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending_orders,
         COUNT(CASE WHEN status = 'review' THEN 1 END) AS review_orders,
         (SELECT COUNT(*) FROM users) AS customers
       FROM orders`
    )
    .get();
  const current = currentCompetition();
  res.json({ ...totals, current: current ? withStats(current) : null, recent: listOrders({ limit: 8 }) });
});

// ---------------------------------------------------------------- prizes (competitions)

const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString('hex') + IMAGE_TYPES[file.mimetype]),
  }),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    IMAGE_TYPES[file.mimetype] ? cb(null, true) : cb(httpError(400, 'The photo must be a JPG, PNG, WEBP or GIF.')),
});

function removeUpload(filename) {
  if (filename) fs.rm(path.join(UPLOAD_DIR, path.basename(filename)), { force: true }, () => {});
}

function competitionFields(body = {}) {
  const title = String(body.title || '').trim();
  if (!title || title.length > 120) throw httpError(400, 'The prize name is required (max 120 characters).');

  const prize_value_cents = randsToCents(body.prize_value);
  if (!(prize_value_cents >= 0)) throw httpError(400, 'Enter the prize value in Rand.');

  const date = (value, label) => {
    if (!value) return null;
    const time = Date.parse(value);
    if (Number.isNaN(time)) throw httpError(400, `The ${label} is not valid.`);
    return new Date(time).toISOString();
  };
  const starts_at = date(body.starts_at, 'start date');
  const draw_at = date(body.draw_at, 'end date');

  const status = String(body.status || 'draft');
  if (!['draft', 'active', 'closed'].includes(status)) throw httpError(400, 'Unknown status.');
  if (status === 'active' && (!starts_at || !draw_at)) {
    throw httpError(400, 'To publish a prize, give it a start date and an end date.');
  }
  if (starts_at && draw_at && draw_at <= starts_at) throw httpError(400, 'The end date must be after the start date.');

  return { title, description: String(body.description || '').trim().slice(0, 5000), prize_value_cents, starts_at, draw_at, status };
}

// Only one prize can run at a time, so published prizes may not have overlapping dates.
function checkOverlap(fields, id = 0) {
  if (fields.status !== 'active') return;
  const clash = db
    .prepare(`SELECT title FROM competitions WHERE status = 'active' AND id != ? AND starts_at < ? AND draw_at > ?`)
    .get(id, fields.draw_at, fields.starts_at);
  if (clash) {
    throw httpError(400, `These dates overlap with "${clash.title}". Only one prize can run at a time, so change the dates.`);
  }
}

router.get('/competitions', (req, res) => {
  res.json(db.prepare('SELECT * FROM competitions ORDER BY COALESCE(starts_at, created_at) DESC').all().map(withStats));
});

router.post('/competitions', upload.single('image'), (req, res) => {
  try {
    const fields = competitionFields(req.body);
    checkOverlap(fields);
    const id = db
      .prepare(
        `INSERT INTO competitions (title, description, prize_value_cents, image_path, starts_at, draw_at, status)
         VALUES (@title, @description, @prize_value_cents, @image_path, @starts_at, @draw_at, @status)`
      )
      .run({ ...fields, image_path: req.file?.filename ?? null }).lastInsertRowid;
    res.json({ id });
  } catch (err) {
    removeUpload(req.file?.filename);
    throw err;
  }
});

router.put('/competitions/:id', upload.single('image'), (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM competitions WHERE id = ?').get(Number(req.params.id));
    if (!existing) throw httpError(404, 'Prize not found.');

    const fields = competitionFields(req.body);
    if (existing.status === 'drawn') fields.status = 'drawn'; // a drawn prize stays drawn
    checkOverlap(fields, existing.id);
    const image_path = req.file ? req.file.filename : existing.image_path;

    db.prepare(
      `UPDATE competitions SET title = @title, description = @description, prize_value_cents = @prize_value_cents,
         image_path = @image_path, starts_at = @starts_at, draw_at = @draw_at, status = @status
       WHERE id = @id`
    ).run({ ...fields, image_path, id: existing.id });
    if (image_path !== existing.image_path) removeUpload(existing.image_path);
    res.json({ ok: true });
  } catch (err) {
    removeUpload(req.file?.filename);
    throw err;
  }
});

router.delete('/competitions/:id', (req, res) => {
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(Number(req.params.id));
  if (!competition) throw httpError(404, 'Prize not found.');
  const orders = db.prepare('SELECT COUNT(*) AS n FROM orders WHERE competition_id = ?').get(competition.id).n;
  if (orders > 0) throw httpError(400, 'This prize already has orders, so it can’t be deleted. Set it to Closed instead.');
  db.prepare('DELETE FROM competitions WHERE id = ?').run(competition.id);
  removeUpload(competition.image_path);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- winner draw

// One participant per customer account (or per email for orders made without an account).
const PARTICIPANT_KEY = `COALESCE('u' || o.user_id, 'e' || LOWER(o.email))`;

// Everyone in the draw with their number of entries. More entries = a bigger slice = a bigger chance.
router.get('/competitions/:id/participants', (req, res) => {
  const rows = db
    .prepare(
      `SELECT ${PARTICIPANT_KEY} AS key, MAX(o.user_id) AS user_id,
              MAX(COALESCE(u.first_name || ' ' || u.last_name, o.name)) AS name,
              MAX(COALESCE(u.email, o.email)) AS email, MAX(COALESCE(u.phone, o.phone)) AS phone,
              COUNT(e.id) AS entries
       FROM entries e
       JOIN orders o ON o.id = e.order_id
       LEFT JOIN users u ON u.id = o.user_id
       WHERE e.competition_id = ?
       GROUP BY ${PARTICIPANT_KEY}
       ORDER BY entries DESC, name`
    )
    .all(Number(req.params.id));
  const total = rows.reduce((sum, p) => sum + p.entries, 0);
  res.json(rows.map((p) => ({ ...p, customer_no: customerNo(p.user_id), chance: total ? p.entries / total : 0 })));
});

const drawDetails = db.prepare(`
  SELECT d.id, d.competition_id, d.entry_id, d.total_entries, d.drawn_at,
         o.id AS order_id, o.user_id, o.name, ${PARTICIPANT_KEY} AS participant_key,
         COALESCE(u.first_name, o.name) AS first_name, COALESCE(u.last_name, '') AS last_name,
         COALESCE(u.email, o.email) AS email, COALESCE(u.phone, o.phone) AS phone
  FROM draws d
  JOIN entries e ON e.id = d.entry_id
  JOIN orders o ON o.id = e.order_id
  LEFT JOIN users u ON u.id = o.user_id
  WHERE d.id = ?
`);
const participantEntries = db.prepare(`
  SELECT COUNT(*) AS n FROM entries e JOIN orders o ON o.id = e.order_id
  WHERE e.competition_id = ? AND ${PARTICIPANT_KEY} = ?
`);
const withTicket = (d) => ({
  ...d,
  ticket: ticketNo(d.entry_id),
  customer_no: customerNo(d.user_id),
  winner_entries: participantEntries.get(d.competition_id, d.participant_key).n,
});

router.get('/competitions/:id/draws', (req, res) => {
  const ids = db.prepare('SELECT id FROM draws WHERE competition_id = ? ORDER BY id DESC').all(Number(req.params.id));
  res.json(ids.map(({ id }) => withTicket(drawDetails.get(id))));
});

router.post('/competitions/:id/draw', (req, res) => {
  const drawId = drawWinner(Number(req.params.id));
  res.json(withTicket(drawDetails.get(drawId)));
});

// ---------------------------------------------------------------- ticket packages

function packageFields(body = {}) {
  const price_cents = randsToCents(body.price);
  if (!(price_cents >= 200 && price_cents <= 10000000)) throw httpError(400, 'Price must be between R2 and R100 000.');
  const entries = Number(body.entries);
  if (!Number.isInteger(entries) || entries < 1 || entries > 10000) {
    throw httpError(400, 'Entries must be a whole number from 1 to 10 000.');
  }
  return {
    price_cents,
    entries,
    badge: String(body.badge || '').trim().slice(0, 30),
    active: body.active === false ? 0 : 1,
  };
}

router.get('/packages', (req, res) => {
  res.json(db.prepare('SELECT * FROM packages ORDER BY price_cents').all());
});

router.post('/packages', (req, res) => {
  const fields = packageFields(req.body);
  const id = db
    .prepare('INSERT INTO packages (price_cents, entries, badge, active) VALUES (@price_cents, @entries, @badge, @active)')
    .run(fields).lastInsertRowid;
  res.json({ id });
});

router.put('/packages/:id', (req, res) => {
  const fields = packageFields(req.body);
  const result = db
    .prepare('UPDATE packages SET price_cents = @price_cents, entries = @entries, badge = @badge, active = @active WHERE id = @id')
    .run({ ...fields, id: Number(req.params.id) });
  if (!result.changes) throw httpError(404, 'Package not found.');
  res.json({ ok: true });
});

router.delete('/packages/:id', (req, res) => {
  db.prepare('DELETE FROM packages WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ---------------------------------------------------------------- bonus spin wheel

router.get('/wheel', (req, res) => res.json(getSetting('wheel', [])));

router.put('/wheel', (req, res) => {
  const segments = req.body?.segments;
  if (!Array.isArray(segments) || segments.length < 2 || segments.length > 12) {
    throw httpError(400, 'The wheel needs between 2 and 12 segments.');
  }
  const clean = segments.map((s) => ({ value: Number(s.value), weight: Number(s.weight) }));
  for (const s of clean) {
    if (!Number.isInteger(s.value) || s.value < 1 || s.value > 100) {
      throw httpError(400, 'Bonus entries must be whole numbers from 1 to 100.');
    }
    if (!Number.isInteger(s.weight) || s.weight < 0 || s.weight > 1000) {
      throw httpError(400, 'Chance weights must be whole numbers from 0 to 1000.');
    }
  }
  if (!clean.some((s) => s.weight > 0)) throw httpError(400, 'At least one segment needs a chance weight above 0.');
  setSetting('wheel', clean);
  res.json(clean);
});

// ---------------------------------------------------------------- orders

router.get('/orders', (req, res) => res.json(listOrders(req.query)));

router.get('/orders.csv', (req, res) => {
  const rows = listOrders({ ...req.query, limit: -1 });
  sendCsv(
    res,
    'winbig-orders',
    ['Order', 'Created (UTC)', 'Paid (UTC)', 'Status', 'Prize', 'Customer ID', 'Name', 'Email', 'Phone',
      'Amount (R)', 'Entries bought', 'Bonus entries', 'Total entries', 'Tickets'],
    rows.map((o) => [o.id, o.created_at, o.paid_at, o.status, o.competition_title, o.customer_no, o.name, o.email, o.phone,
      (o.amount_cents / 100).toFixed(2), o.base_entries, o.bonus_entries, o.tickets.length, o.tickets.join(' ')])
  );
});

// ---------------------------------------------------------------- customers

function listCustomers(q) {
  const statement = db.prepare(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.created_at,
            COUNT(CASE WHEN o.status = 'paid' THEN 1 END) AS paid_orders,
            COALESCE(SUM(CASE WHEN o.status = 'paid' THEN o.amount_cents END), 0) AS spent_cents,
            COALESCE(SUM(CASE WHEN o.status = 'paid' THEN o.base_entries + o.bonus_entries END), 0) AS entries
     FROM users u LEFT JOIN orders o ON o.user_id = u.id
     ${q ? `WHERE u.first_name LIKE @q OR u.last_name LIKE @q OR (u.first_name || ' ' || u.last_name) LIKE @q
               OR u.email LIKE @q OR u.phone LIKE @q OR u.id = @customer` : ''}
     GROUP BY u.id ORDER BY u.id DESC`
  );
  const rows = q ? statement.all({ q: `%${q}%`, customer: parseCustomerNo(q) }) : statement.all();
  return rows.map((c) => ({ ...c, customer_no: customerNo(c.id) }));
}

router.get('/customers', (req, res) => {
  res.json(listCustomers(String(req.query.q || '').trim()).slice(0, 500));
});

router.get('/customers.csv', (req, res) => {
  sendCsv(
    res,
    'winbig-customers',
    ['Customer ID', 'First name', 'Surname', 'Email', 'Phone', 'Signed up (UTC)', 'Paid orders', 'Entries', 'Spent (R)'],
    listCustomers(String(req.query.q || '').trim()).map((c) => [c.customer_no, c.first_name, c.last_name, c.email, c.phone,
      c.created_at, c.paid_orders, c.entries, (c.spent_cents / 100).toFixed(2)])
  );
});

router.put('/customers/:id/password', async (req, res) => {
  checkNewPassword(req.body?.password);
  const id = Number(req.params.id);
  const result = db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(req.body.password), id);
  if (!result.changes) throw httpError(404, 'Customer not found.');
  db.prepare('DELETE FROM user_sessions WHERE user_id = ?').run(id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- payments / Yoco

const WEBHOOK_SETTINGS = ['yoco_webhook_id', 'yoco_webhook_secret', 'yoco_webhook_mode', 'yoco_webhook_registered_at'];

function paymentStatus() {
  const adminKey = getSetting('yoco_secret_key');
  const key = (adminKey || process.env.YOCO_SECRET_KEY || '').trim();
  return {
    mode: yoco.mode(),
    keyHint: key ? `${key.slice(0, 8)}••••${key.slice(-4)}` : null, // the full key never leaves the server
    keySource: adminKey ? 'admin' : key ? 'env' : null,
    publicUrl: publicUrl(),
    webhookUrl: `${publicUrl()}/api/webhooks/yoco`,
    webhookConfigured: Boolean(process.env.YOCO_WEBHOOK_SECRET || getSetting('yoco_webhook_secret')),
    webhookRegisteredAt: getSetting('yoco_webhook_registered_at'),
    webhookMode: getSetting('yoco_webhook_mode'),
  };
}

// Tells Yoco where to send "payment succeeded" notifications (replacing any earlier registration).
async function connectWebhook() {
  if (yoco.mode() === 'demo') throw httpError(400, 'Save your Yoco secret key first.');
  if (!publicUrl().startsWith('https://')) {
    throw httpError(400, 'The website address must start with https:// before Yoco can send payment notifications to it.');
  }
  const oldId = getSetting('yoco_webhook_id');
  if (oldId) await yoco.deleteWebhook(oldId).catch(() => {});
  let hook;
  try {
    hook = await yoco.registerWebhook(`winbig-${yoco.mode()}-${Date.now()}`, `${publicUrl()}/api/webhooks/yoco`);
  } catch (err) {
    console.error(err.message);
    throw httpError(502, `Yoco could not set up payment notifications: ${err.message}`);
  }
  setSetting('yoco_webhook_id', hook.id);
  setSetting('yoco_webhook_secret', hook.secret);
  setSetting('yoco_webhook_mode', hook.mode);
  setSetting('yoco_webhook_registered_at', new Date().toISOString());
}

router.get('/payments', (req, res) => res.json(paymentStatus()));

router.put('/payments/settings', async (req, res) => {
  const { secretKey, publicUrl: address } = req.body || {};

  let origin;
  if (address !== undefined && String(address).trim()) {
    let parsed;
    try {
      parsed = new URL(String(address).trim());
    } catch {
      parsed = null;
    }
    if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
      throw httpError(400, 'The website address should look like https://winbig.co.za');
    }
    origin = parsed.origin;
  }

  const key = String(secretKey || '').trim();
  if (key) {
    if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(key)) {
      throw httpError(400, 'That doesn’t look like a Yoco secret key. It should start with sk_test_ or sk_live_.');
    }
    try {
      await yoco.testKey(key);
    } catch (err) {
      console.error(err.message);
      if ([401, 403].includes(err.yocoStatus)) throw httpError(400, 'Yoco did not accept this key. Copy the secret key again from Yoco.');
      throw httpError(502, 'Could not reach Yoco to check the key. Please try again.');
    }
  }

  if (origin) setSetting('public_url', origin);
  else if (address !== undefined) deleteSetting('public_url');
  if (key) setSetting('yoco_secret_key', key);

  // Connect payment notifications straight away when the site is online.
  let webhook = 'waiting';
  if (yoco.mode() !== 'demo' && publicUrl().startsWith('https://')) {
    await connectWebhook();
    webhook = 'connected';
  }
  res.json({ ...paymentStatus(), webhook });
});

router.delete('/payments/key', async (req, res) => {
  const oldId = getSetting('yoco_webhook_id');
  if (oldId && getSetting('yoco_secret_key')) await yoco.deleteWebhook(oldId).catch(() => {});
  deleteSetting('yoco_secret_key');
  WEBHOOK_SETTINGS.forEach(deleteSetting);
  res.json(paymentStatus());
});

router.post('/payments/register-webhook', async (req, res) => {
  await connectWebhook();
  res.json(paymentStatus());
});

module.exports = Object.assign(router, { getSetupCode, adminPasswordHash });
