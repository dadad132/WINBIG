// Yoco calls this when a payment succeeds. This - not the customer's browser - is
// what marks an order as paid and issues tickets, so payments can't be faked.
const { db, getSetting } = require('./db');
const yoco = require('./yoco');
const { markPaid } = require('./orders');

module.exports = function yocoWebhook(req, res) {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const secrets = [process.env.YOCO_WEBHOOK_SECRET, getSetting('yoco_webhook_secret')].filter(Boolean);

  if (!secrets.length) {
    console.warn('[webhook] Yoco webhook received but no webhook secret is configured (Admin > Payments).');
    return res.status(503).json({ error: 'Webhook not configured' });
  }
  if (!secrets.some((secret) => yoco.verifyWebhook(raw, req.headers, secret))) {
    console.warn('[webhook] Rejected a webhook with an invalid signature.');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(raw.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  if (event.type === 'payment.succeeded') {
    const payment = event.payload || {};
    const meta = payment.metadata || {};

    let order = meta.checkoutId && db.prepare('SELECT * FROM orders WHERE checkout_id = ?').get(String(meta.checkoutId));
    if (!order && meta.orderId) order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(meta.orderId));

    if (!order) {
      console.warn(`[webhook] Payment ${payment.id} does not match any order.`);
    } else if (order.status === 'pending' && payment.amount !== order.amount_cents) {
      db.prepare(`UPDATE orders SET status = 'review', payment_id = ? WHERE id = ?`).run(payment.id, order.id);
      console.warn(`[webhook] Order ${order.id}: paid ${payment.amount} cents, expected ${order.amount_cents}. Flagged for review.`);
    } else if (markPaid(order.id, payment.id)) {
      console.log(`[webhook] Order ${order.id} paid (${order.base_entries} entries issued).`);
    }
  }

  res.json({ received: true });
};
