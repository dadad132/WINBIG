const crypto = require('crypto');
const { db, getSetting } = require('./db');
const { httpError, ticketNo } = require('./util');

// The prize the website shows: the one that's open now, otherwise the next scheduled one,
// otherwise the latest one that has ended but hasn't been drawn yet.
function currentCompetition() {
  const now = new Date().toISOString();
  const next = db
    .prepare(`SELECT * FROM competitions WHERE status = 'active' AND draw_at > ? ORDER BY starts_at LIMIT 1`)
    .get(now);
  if (next) return { ...next, phase: next.starts_at > now ? 'upcoming' : 'open' };
  const ended = db
    .prepare(`SELECT * FROM competitions WHERE status IN ('active', 'closed') ORDER BY draw_at DESC LIMIT 1`)
    .get();
  return ended ? { ...ended, phase: 'ended' } : null;
}

const insertEntry = db.prepare('INSERT INTO entries (order_id, competition_id, source) VALUES (?, ?, ?)');

// Marks a pending order as paid and issues its tickets. Safe to call twice
// (Yoco may deliver the same webhook more than once): returns false if already paid.
const markPaid = db.transaction((orderId, paymentId) => {
  const result = db
    .prepare(`UPDATE orders SET status = 'paid', payment_id = ?, paid_at = datetime('now') WHERE id = ? AND status = 'pending'`)
    .run(paymentId, orderId);
  if (result.changes === 0) return false;

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  for (let i = 0; i < order.base_entries; i++) insertEntry.run(order.id, order.competition_id, 'purchase');
  return true;
});

// Wheel segments the customer can actually land on.
function wheelValues() {
  return getSetting('wheel', []).filter((s) => s.weight > 0).map((s) => s.value);
}

function pickWeighted(segments) {
  const live = segments.filter((s) => s.weight > 0);
  const total = live.reduce((sum, s) => sum + s.weight, 0);
  let r = crypto.randomInt(total);
  for (const s of live) {
    if (r < s.weight) return s.value;
    r -= s.weight;
  }
  return live[live.length - 1].value;
}

// The server decides the result; the browser only animates the wheel to it.
const spin = db.transaction((orderId) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order || order.status !== 'paid') throw httpError(400, 'Your payment has not been confirmed yet.');
  if (order.spun) return { bonus: order.bonus_entries, alreadySpun: true };

  const competition = db.prepare('SELECT status FROM competitions WHERE id = ?').get(order.competition_id);
  if (competition.status === 'drawn') throw httpError(400, 'The winner for this prize has already been drawn.');

  const bonus = pickWeighted(getSetting('wheel', []));
  db.prepare('UPDATE orders SET spun = 1, bonus_entries = ? WHERE id = ?').run(bonus, order.id);
  for (let i = 0; i < bonus; i++) insertEntry.run(order.id, order.competition_id, 'bonus');
  return { bonus, alreadySpun: false };
});

function ticketsFor(orderId) {
  return db
    .prepare('SELECT id, source FROM entries WHERE order_id = ? ORDER BY id')
    .all(orderId)
    .map((e) => ({ ticket: ticketNo(e.id), bonus: e.source === 'bonus' }));
}

// Picks a uniformly random ticket from all of the competition's entries.
const drawWinner = db.transaction((competitionId) => {
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(competitionId);
  if (!competition) throw httpError(404, 'Prize not found.');

  const total = db.prepare('SELECT COUNT(*) AS n FROM entries WHERE competition_id = ?').get(competitionId).n;
  if (total === 0) throw httpError(400, 'There are no paid entries for this prize yet.');

  const entry = db
    .prepare('SELECT id FROM entries WHERE competition_id = ? ORDER BY id LIMIT 1 OFFSET ?')
    .get(competitionId, crypto.randomInt(total));

  const drawId = db
    .prepare('INSERT INTO draws (competition_id, entry_id, total_entries) VALUES (?, ?, ?)')
    .run(competitionId, entry.id, total).lastInsertRowid;
  db.prepare(`UPDATE competitions SET status = 'drawn' WHERE id = ?`).run(competitionId);
  return drawId;
});

module.exports = { currentCompetition, markPaid, spin, ticketsFor, wheelValues, drawWinner };
