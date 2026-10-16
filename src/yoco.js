// Minimal client for the Yoco Checkout API.
// Docs: https://developer.yoco.com/api-reference/checkout-api/checkout/create-checkout
const crypto = require('crypto');
const { getSetting } = require('./db');

const API = 'https://payments.yoco.com/api';

// The key saved in Admin > Payments wins; the .env file is a fallback.
const secretKey = () => (getSetting('yoco_secret_key') || process.env.YOCO_SECRET_KEY || '').trim();

// demo = no key configured (fake payments), test = sk_test_ key, live = sk_live_ key
function mode() {
  const key = secretKey();
  if (!key) return 'demo';
  return key.startsWith('sk_live_') ? 'live' : 'test';
}

async function call(method, path, body, { key = secretKey(), headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }
  if (!res.ok) {
    const err = new Error(`Yoco ${method} ${path} failed (${res.status}): ${data.message || data.description || text}`);
    err.yocoStatus = res.status;
    throw err;
  }
  return data;
}

function createCheckout(checkout, idempotencyKey) {
  return call('POST', '/checkouts', checkout, { headers: idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {} });
}

const registerWebhook = (name, url) => call('POST', '/webhooks', { name, url });
const deleteWebhook = (id) => call('DELETE', `/webhooks/${encodeURIComponent(id)}`);

// A harmless read-only request, used to check a key works before saving it.
const testKey = (key) => call('GET', '/webhooks', undefined, { key });

// Verifies the webhook-id / webhook-timestamp / webhook-signature headers.
// https://developer.yoco.com/guides/online-payments/webhooks/verifying-the-events
function verifyWebhook(rawBody, headers, secret, toleranceSeconds = 180) {
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatureHeader = headers['webhook-signature'];
  if (!id || !timestamp || !signatureHeader || !secret) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;

  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.`).update(rawBody).digest();

  return String(signatureHeader)
    .split(' ')
    .some((entry) => {
      const sig = Buffer.from(entry.split(',')[1] || '', 'base64');
      return sig.length === expected.length && crypto.timingSafeEqual(sig, expected);
    });
}

module.exports = { mode, createCheckout, registerWebhook, deleteWebhook, testKey, verifyWebhook };
