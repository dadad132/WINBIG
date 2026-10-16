const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'winbig.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS competitions (
    id                INTEGER PRIMARY KEY,
    title             TEXT    NOT NULL,
    description       TEXT    NOT NULL DEFAULT '',
    prize_value_cents INTEGER NOT NULL DEFAULT 0,
    image_path        TEXT,
    starts_at         TEXT,                               -- ISO date: ticket sales open
    draw_at           TEXT,                               -- ISO date: ticket sales close and the winner is drawn
    status            TEXT    NOT NULL DEFAULT 'draft',   -- draft | active | closed | drawn
    created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS packages (
    id          INTEGER PRIMARY KEY,
    price_cents INTEGER NOT NULL,
    entries     INTEGER NOT NULL,
    badge       TEXT    NOT NULL DEFAULT '',
    active      INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    first_name    TEXT NOT NULL,
    last_name     TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    phone         TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS user_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id             INTEGER PRIMARY KEY,
    competition_id INTEGER NOT NULL REFERENCES competitions(id),
    user_id        INTEGER REFERENCES users(id),
    package_id     INTEGER,
    name           TEXT    NOT NULL,                   -- customer details are copied onto each order
    email          TEXT    NOT NULL,
    phone          TEXT    NOT NULL,
    amount_cents   INTEGER NOT NULL,
    base_entries   INTEGER NOT NULL,
    bonus_entries  INTEGER NOT NULL DEFAULT 0,
    spun           INTEGER NOT NULL DEFAULT 0,
    status         TEXT    NOT NULL DEFAULT 'pending', -- pending | paid | review
    access_token   TEXT    NOT NULL,
    checkout_id    TEXT UNIQUE,
    payment_id     TEXT,
    created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    paid_at        TEXT
  );
  CREATE INDEX IF NOT EXISTS orders_competition ON orders(competition_id, status);

  CREATE TABLE IF NOT EXISTS entries (
    id             INTEGER PRIMARY KEY,                 -- ticket number = WB + zero-padded id
    order_id       INTEGER NOT NULL REFERENCES orders(id),
    competition_id INTEGER NOT NULL REFERENCES competitions(id),
    source         TEXT    NOT NULL DEFAULT 'purchase' -- purchase | bonus
  );
  CREATE INDEX IF NOT EXISTS entries_competition ON entries(competition_id);
  CREATE INDEX IF NOT EXISTS entries_order ON entries(order_id);

  CREATE TABLE IF NOT EXISTS draws (
    id             INTEGER PRIMARY KEY,
    competition_id INTEGER NOT NULL REFERENCES competitions(id),
    entry_id       INTEGER NOT NULL REFERENCES entries(id),
    total_entries  INTEGER NOT NULL,
    drawn_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );
`);

// Upgrade databases created by the first version of WinBig.
const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
if (!columns('orders').includes('user_id')) db.exec('ALTER TABLE orders ADD COLUMN user_id INTEGER REFERENCES users(id)');
if (!columns('competitions').includes('starts_at')) {
  db.exec(`ALTER TABLE competitions ADD COLUMN starts_at TEXT`);
  db.exec(`UPDATE competitions SET starts_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)`);
}
db.exec('CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id)');

function getSetting(key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}

function setSetting(key, value) {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
}

function deleteSetting(key) {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}

// First run: starter packages, wheel and a sample prize so the site isn't empty.
if (!getSetting('seeded')) {
  db.transaction(() => {
    const addPackage = db.prepare('INSERT INTO packages (price_cents, entries, badge) VALUES (?, ?, ?)');
    addPackage.run(10000, 1, '');
    addPackage.run(40000, 5, 'Popular');
    addPackage.run(80000, 10, 'Best value');

    setSetting('wheel', [
      { value: 1, weight: 40 },
      { value: 2, weight: 30 },
      { value: 3, weight: 20 },
      { value: 4, weight: 10 },
    ]);

    const drawAt = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    drawAt.setUTCHours(17, 0, 0, 0);
    db.prepare(
      `INSERT INTO competitions (title, description, prize_value_cents, starts_at, draw_at, status)
       VALUES (?, ?, ?, ?, ?, 'active')`
    ).run(
      'Sample prize - edit me in the admin panel',
      'Describe your prize here. Upload a photo, set its value and choose the start and end dates in the admin panel.',
      2500000,
      new Date().toISOString(),
      drawAt.toISOString()
    );

    setSetting('seeded', true);
  })();
}

module.exports = { db, getSetting, setSetting, deleteSetting, DATA_DIR, UPLOAD_DIR };
