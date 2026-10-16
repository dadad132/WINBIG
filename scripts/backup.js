// Saves an encrypted copy of the database to the given file. Used by `sudo winbig backup`.
//   node scripts/backup.js /path/to/backup.db
require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const { backupDatabase } = require('../src/db');

const target = process.argv[2];
if (!target) {
  console.error('Usage: node scripts/backup.js <backup-file.db>');
  process.exit(1);
}
const file = path.resolve(target);
if (fs.existsSync(file)) {
  console.error(`${file} already exists.`);
  process.exit(1);
}
backupDatabase(file);
console.log(file);
