const crypto = require('crypto');
const express = require('express');
const { db } = require('./db');
const yoco = require('./yoco');
const { currentUser } = require('./auth');
const { currentCompetition, markPaid, spin, ticketsFor, wheelValues } = require('./orders');
const { httpError, safeEqual, publicUrl, ticketNo, shortName } = require('./util');

const router = express.Router();

const imageUrl = (c) => (c.image_path ? `/uploads/${c.image_path}` : null);

router.get('/public/state', (req, res) => {
  const competition = currentCompetition();
  const packages = db
    .prepare('SELECT id, price_cents, entries, badge FROM packages WHERE active = 1 ORDER BY price_cents')
    .all();
  const last = db
    .prepare(
      `SELECT c.title, o.name, d.entry_id, d.drawn_at
       FROM draws d
       JOIN competitions c ON c.id = d.competition_id
       JOIN entries e ON e.id = d.entry_id
       JOIN orders o ON o.id = e.order_id
       WHERE c.status = 'drawn'
       ORDER BY d.id DESC LIMIT 1`
    )
    .get();

  res.json({
    competition: competition && {
      id: competition.id,
      title: competition.title,
      description: competition.description,
      prize_value_cents: competition.prize_value_cents,
      image_url: imageUrl(competition),
      starts_at: competition.starts_at,
      draw_at: competition.draw_at,
      phase: competition.phase, // upcoming | open | ended
    },
    packages,
    wheel: wheelValues(),
    lastWinner: last && { prize: last.title, name: shortName(last.name), ticket: ticketNo(last.entry_id), drawn_at: last.drawn_at },
    paymentMode: yoco.mode(),
  });
});

router.post('/checkout', async (req, res) => {
  const user = currentUser(req);
  if (!user) throw httpError(401, 'Please sign in to buy tickets.');
  if (req.body?.agree !== true) throw httpError(400, 'Please accept the terms & conditions.');

  const competition = currentCompetition();
  if (competition?.phase === 'upcoming') throw httpError(400, 'Entries for this prize are not open yet.');
  if (competition?.phase !== 'open') throw httpError(400, 'Entries are currently closed.');

  const pkg = db.prepare('SELECT * FROM packages WHERE id = ? AND active = 1').get(Number(req.body?.packageId));
  if (!pkg) throw httpError(400, 'That ticket package is no longer available. Please refresh the page.');

  // The price always comes from the database, never from the browser.
  const token = crypto.randomBytes(24).toString('hex');
  const orderId = db
    .prepare(
      `INSERT INTO orders (competition_id, user_id, package_id, name, email, phone, amount_cents, base_entries, access_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      competition.id,
      user.id,
      pkg.id,
      `${user.first_name} ${user.last_name}`,
      user.email,
      user.phone,
      pkg.price_cents,
      pkg.entries,
      token
    ).lastInsertRowid;

  const query = `order=${orderId}&t=${token}`;
  if (yoco.mode() === 'demo') return res.json({ redirectUrl: `/demo-pay?${query}` });

  const returnUrl = `${publicUrl()}/success?${query}`;
  const entriesLabel = `${pkg.entries} ${pkg.entries === 1 ? 'entry' : 'entries'}`;
  try {
    const checkout = await yoco.createCheckout(
      {
        amount: pkg.price_cents,
        currency: 'ZAR',
        successUrl: returnUrl,
        cancelUrl: `${returnUrl}&cancelled=1`,
        failureUrl: `${returnUrl}&failed=1`,
        externalId: `winbig-order-${orderId}`,
        metadata: { orderId: String(orderId), competitionId: String(competition.id) },
        lineItems: [
          {
            displayName: `${competition.title.slice(0, 80)} - ${entriesLabel}`,
            quantity: 1,
            pricingDetails: { price: pkg.price_cents },
          },
        ],
      },
      `winbig-order-${orderId}`
    );
    db.prepare('UPDATE orders SET checkout_id = ? WHERE id = ?').run(checkout.id, orderId);
    res.json({ redirectUrl: checkout.redirectUrl });
  } catch (err) {
    db.prepare('DELETE FROM orders WHERE id = ?').run(orderId);
    console.error(err.message);
    throw httpError(502, 'We could not start the payment. Please try again in a moment.');
  }
});

// Orders are looked up with their id plus a secret token that only the buyer has (it's in their return link).
function loadOrder(id, token) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(Number(id));
  if (!order || !token || !safeEqual(order.access_token, token)) throw httpError(404, 'Order not found.');
  return order;
}

function orderView(order) {
  const competition = db.prepare('SELECT * FROM competitions WHERE id = ?').get(order.competition_id);
  return {
    id: order.id,
    status: order.status,
    first_name: order.name.split(' ')[0],
    amount_cents: order.amount_cents,
    base_entries: order.base_entries,
    bonus_entries: order.bonus_entries,
    spun: Boolean(order.spun),
    tickets: ticketsFor(order.id),
    competition: {
      title: competition.title,
      image_url: imageUrl(competition),
      draw_at: competition.draw_at,
      status: competition.status,
    },
    wheel: wheelValues(),
  };
}

router.get('/orders/:id', (req, res) => {
  res.json(orderView(loadOrder(req.params.id, req.query.t)));
});

router.post('/orders/:id/spin', (req, res) => {
  const order = loadOrder(req.params.id, req.body?.t);
  const result = spin(order.id);
  const updated = db.prepare('SELECT * FROM orders WHERE id = ?').get(order.id);
  res.json({ ...result, order: orderView(updated) });
});

// Fake payment used when no Yoco key is configured, so the whole flow can be tested for free.
router.post('/demo/pay', (req, res) => {
  if (yoco.mode() !== 'demo') throw httpError(404, 'Not found.');
  const order = loadOrder(req.body?.order, req.body?.t);
  markPaid(order.id, `demo_${crypto.randomBytes(6).toString('hex')}`);
  res.json({ redirectUrl: `/success?order=${order.id}&t=${order.access_token}` });
});

module.exports = router;
