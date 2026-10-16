const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3-multiple-ciphers');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'winbig.db');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------------------------------------------------------------- encryption
// On a server, install.sh sets DB_KEY and the whole database file is encrypted (AES-256, SQLCipher 4
// format), so a copy of the file or a backup is unreadable without the key. Without DB_KEY the database
// is stored unencrypted, which is fine for trying WinBig on your own computer.

const KEY = (process.env.DB_KEY || '').trim();
delete process.env.DB_KEY; // keep the key out of anything else that reads the environment
if (KEY && !/^[A-Za-z0-9]{32,128}$/.test(KEY)) {
  throw new Error('DB_KEY must be 32 to 128 letters and numbers.');
}

function unlock(conn) {
  if (!KEY) return;
  conn.pragma("cipher = 'sqlcipher'");
  conn.pragma('legacy = 4');
  if (KEY) conn.pragma(`key = '${KEY}'`);
}

function isUnencrypted(file) {
  const header = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, header, 0, 16, 0);
  fs.closeSync(fd);
  return header.toString('latin1') === 'SQLite format 3\0';
}

// Encrypts a database that was created before encryption was switched on, keeping all its data.
// Row counts are compared afterwards; if anything differs the original file is put back.
function encryptExistingDatabase() {
  const tableCounts = (conn) =>
    JSON.stringify(
      conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all()
        .map(({ name }) => [name, conn.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n])
    );

  const plain = new Database(DB_FILE);
  plain.pragma('wal_checkpoint(TRUNCATE)');
  plain.pragma('journal_mode = DELETE');
  const before = tableCounts(plain);
  plain.close();

  const original = `${DB_FILE}.before-encryption`;
  fs.copyFileSync(DB_FILE, original);
  try {
    const conn = new Database(DB_FILE);
    conn.pragma("cipher = 'sqlcipher'");
    conn.pragma('legacy = 4');
    conn.pragma(`rekey = '${KEY}'`);
    conn.close();

    const check = new Database(DB_FILE);
    unlock(check);
    const after = tableCounts(check);
    check.close();
    if (after !== before) throw new Error('the encrypted copy does not match the original');
    fs.rmSync(original);
    fs.rmSync(`${DB_FILE}-shm`, { force: true });
  } catch (err) {
    fs.copyFileSync(original, DB_FILE);
    fs.rmSync(original);
    throw new Error(`Could not encrypt the database, so it was left unchanged: ${err.message}`);
  }
}

if (KEY && fs.existsSync(DB_FILE) && fs.statSync(DB_FILE).size > 0 && isUnencrypted(DB_FILE)) {
  console.log('  Encrypting the existing database...');
  encryptExistingDatabase();
  console.log('  The database is now encrypted.');
}

const db = new Database(DB_FILE);
unlock(db);
try {
  db.prepare('SELECT COUNT(*) FROM sqlite_master').get();
} catch {
  throw new Error(
    KEY
      ? 'Could not open the database: the encryption key (DB_KEY) is wrong, or the file is damaged.'
      : 'The database is encrypted, so WinBig needs its key. Set DB_KEY (on a server: run it with sudo winbig).'
  );
}
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

// A consistent copy of the live database, encrypted with the same key (safe while WinBig is running).
function backupDatabase(file) {
  db.prepare('VACUUM INTO ?').run(file);
}

const isEncrypted = () => Boolean(KEY);

module.exports = { db, getSetting, setSetting, deleteSetting, backupDatabase, isEncrypted, DATA_DIR, UPLOAD_DIR, DB_FILE };
