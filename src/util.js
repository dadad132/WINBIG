const crypto = require('crypto');
const { promisify } = require('util');
const { getSetting } = require('./db');

const scrypt = promisify(crypto.scrypt);

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  err.expose = true; // safe to show this message to the user
  return err;
}

// Constant-time string comparison (hashing first makes lengths equal).
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// The address saved in Admin > Payments wins; the .env file is a fallback.
function publicUrl() {
  return (getSetting('public_url') || process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
}

// "1 250.50" / "R1250" -> 125050 cents. Returns NaN when invalid.
function randsToCents(value) {
  const n = Number(String(value ?? '').replace(/[R\s,]/gi, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}

const ticketNo = (entryId) => 'WB' + String(entryId).padStart(6, '0');

// Every customer account gets a unique customer ID, e.g. WBC-00042.
const customerNo = (userId) => (userId ? 'WBC-' + String(userId).padStart(5, '0') : null);
// "WBC-00042" -> 42, anything else -> -1
const parseCustomerNo = (text) => (/^\s*wbc/i.test(text) ? Number(String(text).replace(/\D/g, '')) || -1 : -1);

// "Thabo Mokoena" -> "Thabo M."
function shortName(name) {
  const parts = String(name).trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.` : parts[0];
}

// Session tokens are stored hashed, so a leaked database can't be used to log in.
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

// Passwords are stored as salted scrypt hashes, never as plain text.
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function checkNewPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw httpError(400, 'The password needs at least 8 characters.');
  if (password.length > 200) throw httpError(400, 'That password is too long.');
}

// Brute-force protection: after `limit` failed attempts an IP is blocked for 15 minutes.
function loginLimiter(limit = 10, windowMs = 15 * 60 * 1000) {
  const failures = new Map(); // ip -> { count, since }
  return {
    check(ip) {
      const record = failures.get(ip);
      if (record && Date.now() - record.since < windowMs && record.count >= limit) {
        throw httpError(429, 'Too many attempts. Please wait 15 minutes and try again.');
      }
    },
    fail(ip) {
      const now = Date.now();
      const record = failures.get(ip);
      const fresh = !record || now - record.since >= windowMs;
      failures.set(ip, fresh ? { count: 1, since: now } : { count: record.count + 1, since: record.since });
    },
    clear(ip) {
      failures.delete(ip);
    },
  };
}

// True only for a browser on the same computer as the server, not coming through a proxy.
function isLocalRequest(req) {
  const proxied = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'via'].some((h) => req.headers[h]);
  return !proxied && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
}

module.exports = {
  httpError,
  safeEqual,
  publicUrl,
  randsToCents,
  ticketNo,
  customerNo,
  parseCustomerNo,
  shortName,
  hashToken,
  readCookie,
  hashPassword,
  verifyPassword,
  checkNewPassword,
  loginLimiter,
  isLocalRequest,
};
