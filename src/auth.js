// Customer sign-in sessions (the admin panel has its own, separate sessions).
const crypto = require('crypto');
const { db } = require('./db');
const { httpError, readCookie, hashToken, customerNo } = require('./util');

const COOKIE = 'wb_user';
const SESSION_MS = 30 * 24 * 3600 * 1000;

function startSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('DELETE FROM user_sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO user_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    hashToken(token),
    userId,
    Date.now() + SESSION_MS
  );
  // "lax" so customers stay signed in when Yoco sends them back after paying.
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_MS, path: '/' });
}

function endSession(req, res) {
  const token = readCookie(req, COOKIE);
  if (token) db.prepare('DELETE FROM user_sessions WHERE token_hash = ?').run(hashToken(token));
  res.clearCookie(COOKIE, { path: '/' });
}

// The details of a customer that are safe to send to the browser.
const publicUser = (u) => ({
  id: u.id,
  customer_no: customerNo(u.id),
  first_name: u.first_name,
  last_name: u.last_name,
  email: u.email,
  phone: u.phone,
});

function currentUser(req) {
  const token = readCookie(req, COOKIE);
  if (!token) return null;
  const user = db
    .prepare(
      `SELECT u.* FROM user_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`
    )
    .get(hashToken(token), Date.now());
  return user ? publicUser(user) : null;
}

function requireUser(req, res, next) {
  const user = currentUser(req);
  if (!user) throw httpError(401, 'Please sign in first.');
  req.user = user;
  next();
}

module.exports = { startSession, endSession, currentUser, requireUser, publicUser };
