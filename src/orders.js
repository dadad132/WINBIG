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

// ---------------------------------------------------------------- credits (1 credit = 1 spin)

const balanceQuery = db.prepare('SELECT COALESCE(SUM(change), 0) AS n FROM credit_ledger WHERE user_id = ?');
const creditBalance = (userId) => balanceQuery.get(userId).n;

const ledgerInsert = db.prepare(
  `INSERT INTO credit_ledger (user_id, change, reason, order_id, spin_id, note)
   VALUES (@user_id, @change, @reason, @order_id, @spin_id, @note)`
);
function addCredits(userId, change, reason, { orderId = null, spinId = null, note = '' } = {}) {
  ledgerInsert.run({ user_id: userId, change, reason, order_id: orderId, spin_id: spinId, note });
}

// Admin adds or removes credits by hand (refunds, prizes, corrections).
const adjustCredits = db.transaction((userId, change, note) => {
  if (creditBalance(userId) + change < 0) throw httpError(400, "That would take the customer's credits below zero.");
  addCredits(userId, change, 'admin', { note });
  return creditBalance(userId);
});

// Marks a pending order as paid and adds its credits to the customer's account. Safe to call twice
// (Yoco may deliver the same webhook more than once): returns false if the order was already paid.
const markPaid = db.transaction((orderId, paymentId) => {
  const result = db
    .prepare(`UPDATE orders SET status = 'paid', payment_id = ?, paid_at = datetime('now') WHERE id = ? AND status = 'pending'`)
    .run(paymentId, orderId);
  if (result.changes === 0) return false;

  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (order.credits > 0 && order.user_id) addCredits(order.user_id, order.credits, 'purchase', { orderId: order.id });
  // Orders from older versions bought entries directly.
  const insert = db.prepare(`INSERT INTO entries (competition_id, user_id, order_id, source) VALUES (?, ?, ?, 'purchase')`);
  for (let i = 0; i < order.base_entries; i++) insert.run(order.competition_id, order.user_id, order.id);
  return true;
});

// ---------------------------------------------------------------- the wheel

// Wheel segments a customer can actually land on.
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

const spinInsert = db.prepare('INSERT INTO spins (user_id, competition_id, entries) VALUES (?, ?, ?)');
const spinEntryInsert = db.prepare(`INSERT INTO entries (competition_id, user_id, spin_id, source) VALUES (?, ?, ?, 'spin')`);

// One spin: uses one credit and adds the entries the wheel lands on to the prize that's open now.
// The server decides the result; the browser only animates the wheel to it.
const spinWheel = db.transaction((userId) => {
  const competition = currentCompetition();
  if (competition?.phase === 'upcoming') throw httpError(400, 'Spinning opens when the prize starts. Your spins are saved.');
  if (competition?.phase !== 'open') throw httpError(400, 'There is no prize open right now. Your spins are saved for the next one.');

  const balance = creditBalance(userId);
  if (balance < 1) throw httpError(400, 'You have no spins left. Buy more spins or credits to keep playing.');

  const won = pickWeighted(getSetting('wheel', []));
  const spinId = spinInsert.run(userId, competition.id, won).lastInsertRowid;
  addCredits(userId, -1, 'spin', { spinId });
  const tickets = [];
  for (let i = 0; i < won; i++) tickets.push(ticketNo(spinEntryInsert.run(competition.id, userId, spinId).lastInsertRowid));
  return { entries: won, tickets, credits: balance - 1, competitionId: competition.id };
});

const userEntriesQuery = db.prepare('SELECT COUNT(*) AS n FROM entries WHERE competition_id = ? AND user_id = ?');
const userEntries = (competitionId, userId) => userEntriesQuery.get(competitionId, userId).n;

// ---------------------------------------------------------------- the draw

// Picks a uniformly random ticket from all of the competition's entries.
const drawWinner = db.transaction((competitionId) => {
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(competitionId);
  if (!competition) throw httpError(404, 'Prize not found.');

  const total = db.prepare('SELECT COUNT(*) AS n FROM entries WHERE competition_id = ?').get(competitionId).n;
  if (total === 0) throw httpError(400, 'There are no entries for this prize yet.');

  const entry = db
    .prepare('SELECT id FROM entries WHERE competition_id = ? ORDER BY id LIMIT 1 OFFSET ?')
    .get(competitionId, crypto.randomInt(total));

  const drawId = db
    .prepare('INSERT INTO draws (competition_id, entry_id, total_entries) VALUES (?, ?, ?)')
    .run(competitionId, entry.id, total).lastInsertRowid;
  db.prepare(`UPDATE competitions SET status = 'drawn' WHERE id = ?`).run(competitionId);
  return drawId;
});

module.exports = {
  currentCompetition,
  creditBalance,
  adjustCredits,
  markPaid,
  wheelValues,
  spinWheel,
  userEntries,
  drawWinner,
};
