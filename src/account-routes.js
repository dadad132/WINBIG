// Customer accounts: sign up, sign in, details, password and "My tickets".
const express = require('express');
const { db } = require('./db');
const { startSession, endSession, currentUser, requireUser, publicUser } = require('./auth');
const { ticketsFor } = require('./orders');
const { httpError, hashPassword, verifyPassword, checkNewPassword, loginLimiter } = require('./util');

const router = express.Router();
const limiter = loginLimiter();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
let dummyHash; // checked for unknown emails so they take as long as a wrong password

function cleanDetails(body = {}) {
  const tidy = (v) => String(v || '').trim().replace(/\s+/g, ' ');
  const first_name = tidy(body.first_name);
  const last_name = tidy(body.last_name);
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').replace(/[^\d+]/g, '');
  if (!first_name || first_name.length > 50) throw httpError(400, 'Please enter your first name.');
  if (!last_name || last_name.length > 50) throw httpError(400, 'Please enter your surname.');
  if (!EMAIL_RE.test(email) || email.length > 120) throw httpError(400, 'Please enter a valid email address.');
  if (!/^\+?\d{9,15}$/.test(phone)) throw httpError(400, 'Please enter a valid cellphone number.');
  return { first_name, last_name, email, phone };
}

const emailTaken = (email, exceptId = 0) => db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, exceptId);

router.post('/signup', async (req, res) => {
  const details = cleanDetails(req.body);
  checkNewPassword(req.body?.password);
  if (req.body?.agree !== true) throw httpError(400, 'Please confirm you are 18 or older and accept the terms.');
  if (emailTaken(details.email)) throw httpError(409, 'There is already an account with this email. Please sign in instead.');

  const password_hash = await hashPassword(req.body.password);
  let id;
  try {
    id = db
      .prepare(
        `INSERT INTO users (first_name, last_name, email, phone, password_hash)
         VALUES (@first_name, @last_name, @email, @phone, @password_hash)`
      )
      .run({ ...details, password_hash }).lastInsertRowid;
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') throw httpError(409, 'There is already an account with this email. Please sign in instead.');
    throw err;
  }
  startSession(req, res, id);
  res.json({ user: publicUser({ id, ...details }) });
});

router.post('/signin', async (req, res) => {
  limiter.check(req.ip);
  const email = String(req.body?.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  dummyHash ??= await hashPassword('not-a-real-password');
  const valid = await verifyPassword(String(req.body?.password || ''), user ? user.password_hash : dummyHash);
  if (!user || !valid) {
    limiter.fail(req.ip);
    throw httpError(401, 'Wrong email or password.');
  }
  limiter.clear(req.ip);
  startSession(req, res, user.id);
  res.json({ user: publicUser(user) });
});

router.post('/signout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => res.json({ user: currentUser(req) }));

router.put('/me', requireUser, (req, res) => {
  const details = cleanDetails(req.body);
  if (emailTaken(details.email, req.user.id)) throw httpError(409, 'Another account already uses this email.');
  db.prepare('UPDATE users SET first_name = @first_name, last_name = @last_name, email = @email, phone = @phone WHERE id = @id').run({
    ...details,
    id: req.user.id,
  });
  res.json({ user: publicUser({ id: req.user.id, ...details }) });
});

router.put('/password', requireUser, async (req, res) => {
  const { password_hash } = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!(await verifyPassword(String(req.body?.current || ''), password_hash))) throw httpError(400, 'Your current password is wrong.');
  checkNewPassword(req.body?.password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(req.body.password), req.user.id);
  res.json({ ok: true });
});

router.get('/orders', requireUser, (req, res) => {
  // Unpaid orders older than 2 hours were most likely abandoned, so they're hidden.
  const rows = db
    .prepare(
      `SELECT o.*, c.title, c.image_path, c.draw_at, c.status AS competition_status,
              (SELECT e.order_id FROM draws d JOIN entries e ON e.id = d.entry_id
               WHERE d.competition_id = c.id ORDER BY d.id DESC LIMIT 1) AS winning_order
       FROM orders o JOIN competitions c ON c.id = o.competition_id
       WHERE o.user_id = ? AND (o.status != 'pending' OR o.created_at > datetime('now', '-2 hours'))
       ORDER BY o.id DESC`
    )
    .all(req.user.id);

  res.json(
    rows.map((o) => ({
      id: o.id,
      status: o.status,
      amount_cents: o.amount_cents,
      base_entries: o.base_entries,
      bonus_entries: o.bonus_entries,
      spun: Boolean(o.spun),
      created_at: o.created_at,
      link: `/success?order=${o.id}&t=${o.access_token}`,
      tickets: ticketsFor(o.id),
      won: o.competition_status === 'drawn' && o.winning_order === o.id,
      competition: {
        title: o.title,
        image_url: o.image_path ? `/uploads/${o.image_path}` : null,
        draw_at: o.draw_at,
        status: o.competition_status,
      },
    }))
  );
});

module.exports = router;
