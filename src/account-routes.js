// Customer accounts: sign up, sign in, details, password, credits, spinning and "My tickets".
const express = require('express');
const { db } = require('./db');
const { startSession, endSession, currentUser, requireUser, publicUser } = require('./auth');
const { currentCompetition, creditBalance, spinWheel, userEntries, wheelValues } = require('./orders');
const { httpError, hashPassword, verifyPassword, checkNewPassword, loginLimiter, rateLimiter, isLocalRequest, ticketNo } = require('./util');

const router = express.Router();
const limiter = loginLimiter();
const signupLimiter = rateLimiter(10, 3600 * 1000, 'Too many new accounts from your network. Please try again later.');
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
const withCredits = (user) => user && { ...user, credits: creditBalance(user.id) };
const imageUrl = (c) => (c.image_path ? `/uploads/${c.image_path}` : null);

router.post('/signup', async (req, res) => {
  const details = cleanDetails(req.body);
  checkNewPassword(req.body?.password);
  if (req.body?.agree !== true) throw httpError(400, 'Please confirm you are 18 or older and accept the terms.');
  if (emailTaken(details.email)) throw httpError(409, 'There is already an account with this email. Please sign in instead.');
  if (!isLocalRequest(req)) signupLimiter.hit(req.ip);

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
  res.json({ user: withCredits(publicUser({ id, ...details })) });
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
  res.json({ user: withCredits(publicUser(user)) });
});

router.post('/signout', (req, res) => {
  endSession(req, res);
  res.json({ ok: true });
});

router.get('/me', (req, res) => res.json({ user: withCredits(currentUser(req)) }));

router.put('/me', requireUser, (req, res) => {
  const details = cleanDetails(req.body);
  if (emailTaken(details.email, req.user.id)) throw httpError(409, 'Another account already uses this email.');
  db.prepare('UPDATE users SET first_name = @first_name, last_name = @last_name, email = @email, phone = @phone WHERE id = @id').run({
    ...details,
    id: req.user.id,
  });
  res.json({ user: withCredits(publicUser({ id: req.user.id, ...details })) });
});

router.put('/password', requireUser, async (req, res) => {
  const { password_hash } = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!(await verifyPassword(String(req.body?.current || ''), password_hash))) throw httpError(400, 'Your current password is wrong.');
  checkNewPassword(req.body?.password);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(req.body.password), req.user.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- spinning

function spinState(userId) {
  const c = currentCompetition();
  return {
    credits: creditBalance(userId),
    wheel: wheelValues(),
    competition: c && {
      id: c.id,
      title: c.title,
      image_url: imageUrl(c),
      starts_at: c.starts_at,
      draw_at: c.draw_at,
      phase: c.phase,
      my_entries: userEntries(c.id, userId),
    },
  };
}

router.get('/spin', requireUser, (req, res) => res.json(spinState(req.user.id)));

router.post('/spin', requireUser, (req, res) => {
  const result = spinWheel(req.user.id);
  res.json({ ...result, my_entries: userEntries(result.competitionId, req.user.id) });
});

// ---------------------------------------------------------------- my tickets, purchases & credit history

router.get('/overview', requireUser, (req, res) => {
  const userId = req.user.id;

  const competitions = db
    .prepare(
      `SELECT c.id, c.title, c.image_path, c.draw_at, c.status, COUNT(e.id) AS entries,
              (SELECT COALESCE(we.user_id, wo.user_id) FROM draws d
                 JOIN entries we ON we.id = d.entry_id LEFT JOIN orders wo ON wo.id = we.order_id
               WHERE d.competition_id = c.id ORDER BY d.id DESC LIMIT 1) AS winner_id
       FROM entries e JOIN competitions c ON c.id = e.competition_id
       WHERE e.user_id = ?
       GROUP BY c.id ORDER BY MAX(e.id) DESC`
    )
    .all(userId)
    .map((c) => ({
      id: c.id,
      title: c.title,
      image_url: imageUrl(c),
      draw_at: c.draw_at,
      status: c.status,
      entries: c.entries,
      won: c.status === 'drawn' && c.winner_id === userId,
      tickets: db
        .prepare('SELECT id FROM entries WHERE user_id = ? AND competition_id = ? ORDER BY id LIMIT 300')
        .all(userId, c.id)
        .map((e) => ticketNo(e.id)),
    }));

  // Unpaid orders older than 2 hours were most likely abandoned, so they're hidden.
  const purchases = db
    .prepare(
      `SELECT id, created_at, status, kind, credits, base_entries, amount_cents FROM orders
       WHERE user_id = ? AND (status != 'pending' OR created_at > datetime('now', '-2 hours'))
       ORDER BY id DESC LIMIT 50`
    )
    .all(userId);

  res.json({ credits: creditBalance(userId), competitions, purchases });
});

module.exports = router;
