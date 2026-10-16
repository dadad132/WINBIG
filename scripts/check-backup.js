// Checks that a backup opens with this server's key and shows what's in it.
//   node scripts/check-backup.js /path/to/backup.db      (used by `sudo winbig restore`)
const Database = require('better-sqlite3-multiple-ciphers');

const key = (process.env.DB_KEY || '').trim();
const conn = new Database(process.argv[2], { readonly: true, fileMustExist: true });
if (key) {
  conn.pragma("cipher = 'sqlcipher'");
  conn.pragma('legacy = 4');
  conn.pragma(`key = '${key.replace(/[^A-Za-z0-9]/g, '')}'`);
}
const count = (table) => conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const integrity = conn.pragma('integrity_check', { simple: true });
if (integrity !== 'ok') throw new Error(`The backup is damaged: ${integrity}`);
console.log(`${count('users')} customers, ${count('orders')} orders, ${count('entries')} tickets`);
