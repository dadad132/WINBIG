require('dotenv').config({ quiet: true });

const path = require('path');
const express = require('express');

const { UPLOAD_DIR } = require('./src/db');
const yoco = require('./src/yoco');
const { publicUrl } = require('./src/util');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  });
  next();
});

// The webhook needs the untouched request body to check Yoco's signature, so it comes before express.json().
app.post('/api/webhooks/yoco', express.raw({ type: '*/*', limit: '1mb' }), require('./src/webhooks'));

app.use(express.json({ limit: '100kb' }));
const adminRoutes = require('./src/admin-routes');
app.use('/api/admin', adminRoutes);
app.use('/api/account', require('./src/account-routes'));
app.use('/api', require('./src/public-routes'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
app.use((req, res) => res.status(404).sendFile(path.join(__dirname, 'public', '404.html')));

app.use((err, req, res, next) => {
  let status = err.status || err.statusCode || 500;
  let message = err.expose ? err.message : 'Something went wrong. Please try again.';
  if (err.name === 'MulterError') {
    status = 400;
    message = err.code === 'LIMIT_FILE_SIZE' ? 'That photo is too big (max 8 MB).' : err.message;
  }
  if (status >= 500) console.error(err);
  res.status(status).json({ error: message });
});

const port = Number(process.env.PORT) || 3000;
// HOST=127.0.0.1 keeps the app private when it runs behind nginx (see install.sh).
const listenArgs = process.env.HOST ? [port, process.env.HOST] : [port];
app.listen(...listenArgs, () => {
  console.log(`\n  WinBig is running at http://localhost:${port}`);
  console.log(`  Admin panel:         http://localhost:${port}/admin`);
  console.log(`  Payments:            ${yoco.mode().toUpperCase()} mode${yoco.mode() === 'demo' ? ' (no Yoco key set - payments are simulated)' : ''}`);
  console.log(`  Public URL:          ${publicUrl()}\n`);
  if (!adminRoutes.adminPasswordHash()) {
    console.log('  First time? Open the admin panel to create your admin password.');
    adminRoutes.getSetupCode();
    console.log('');
  }
});
