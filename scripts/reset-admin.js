// Forgot the admin password? Run:  npm run reset-admin
// Then open /admin and create a new password.
require('dotenv').config({ quiet: true });
const { db, deleteSetting } = require('../src/db');

deleteSetting('admin_password_hash');
db.prepare('DELETE FROM sessions').run();
console.log('The admin password has been removed. Open /admin to create a new one.');
