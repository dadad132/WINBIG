const crypto = require('crypto');
const express = require('express');
const { db } = require('./db');
const yoco = require('./yoco');
const { currentUser } = require('./auth');
const { currentCompetition, creditBalance, markPaid, wheelValues } = require('./orders');
const { siteSettings, MAX_CUSTOM_CREDITS } = require('./site');
const { httpError, safeEqual, publicUrl, ticketNo, shortName, rateLimiter, isLocalRequest } = require('./util');

const router = express.Router();
const checkoutLimiter = rateLimiter(30, 3600 * 1000, 'Too many payment attempts. Please try again in an hour.');

const imageUrl = (c) => (c.image_path ? `/uploads/${c.image_path}` : null);
const registeredCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
const spinsLabel = (n) => `${n} ${n === 1 ? 'spin' : 'spins'}`;

router.get('/public/state', (req, res) => {
  const competition = currentCompetition();
  const site = siteSettings();
  const packages = db
    .prepare('SELECT id, price_cents, spins, badge FROM packages WHERE active = 1 ORDER BY price_cents')
    .all();
  const last = db
    .prepare(
      `SELECT c.title, COALESCE(u.first_name || ' ' || u.last_name, o.name) AS name, d.entry_id, d.drawn_at
       FROM draws d
       JOIN competitions c ON c.id = d.competition_id
       JOIN entries e ON e.id = d.entry_id
       LEFT JOIN orders o ON o.id = e.order_id
       LEFT JOIN users u ON u.id = COALESCE(e.user_id, o.user_id)
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
    credit_price_cents: site.credit_price_cents,
    max_custom_credits: MAX_CUSTOM_CREDITS,
    wheel: wheelValues(),
    registered: site.show_counter ? registeredCount() : null,
    about: site.about,
    contact: site.contact,
    lastWinner: last && { prize: last.title, name: shortName(last.name), ticket: ticketNo(last.entry_id), drawn_at: last.drawn_at },
    paymentMode: yoco.mode(),
  });
});

// For the live "people registered" counter on the home page.
router.get('/public/stats', (req, res) => {
  res.json({ registered: siteSettings().show_counter ? registeredCount() : null });
});

// Buy spins (a package) or credits (any number). Both add credits to the customer's account:
// 1 credit = 1 spin. Spins packages take the customer straight to the wheel afterwards.
router.post('/checkout', async (req, res) => {
  if (!isLocalRequest(req)) checkoutLimiter.hit(req.ip);
  const user = currentUser(req);
  if (!user) throw httpError(401, 'Please sign in to buy spins.');
  if (req.body?.agree !== true) throw httpError(400, 'Please accept the terms & conditions.');

  const competition = currentCompetition();
  if (!competition || competition.phase === 'ended') {
    throw httpError(400, 'Sales are closed right now. Please check back for the next prize.');
  }

  // The price always comes from the database, never from the browser.
  let kind, credits, amount, packageId;
  if (req.body?.packageId != null) {
    const pkg = db.prepare('SELECT * FROM packages WHERE id = ? AND active = 1').get(Number(req.body.packageId));
    if (!pkg) throw httpError(400, 'That package is no longer available. Please refresh the page.');
    [kind, credits, amount, packageId] = ['spins', pkg.spins, pkg.price_cents, pkg.id];
  } else {
    credits = Number(req.body?.credits);
    if (!Number.isInteger(credits) || credits < 1 || credits > MAX_CUSTOM_CREDITS) {
      throw httpError(400, `Choose between 1 and ${MAX_CUSTOM_CREDITS} credits.`);
    }
    [kind, amount, packageId] = ['credits', credits * siteSettings().credit_price_cents, null];
  }

  const token = crypto.randomBytes(24).toString('hex');
  const orderId = db
    .prepare(
      `INSERT INTO orders (competition_id, user_id, package_id, name, email, phone, amount_cents, kind, credits, base_entries, access_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .run(
      competition.id,
      user.id,
      packageId,
      `${user.first_name} ${user.last_name}`,
      user.email,
      user.phone,
      amount,
      kind,
      credits,
      token
    ).lastInsertRowid;

  const query = `order=${orderId}&t=${token}`;
  if (yoco.mode() === 'demo') return res.json({ redirectUrl: `/demo-pay?${query}` });

  const returnUrl = `${publicUrl()}/success?${query}`;
  const label = kind === 'spins' ? spinsLabel(credits) : `${credits} ${credits === 1 ? 'credit' : 'credits'}`;
  try {
    const checkout = await yoco.createCheckout(
      {
        amount,
        currency: 'ZAR',
        successUrl: returnUrl,
        cancelUrl: `${returnUrl}&cancelled=1`,
        failureUrl: `${returnUrl}&failed=1`,
        externalId: `winbig-order-${orderId}`,
        metadata: { orderId: String(orderId), competitionId: String(competition.id) },
        lineItems: [{ displayName: `WinBig - ${label}`, quantity: 1, pricingDetails: { price: amount } }],
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
  return {
    id: order.id,
    status: order.status,
    kind: order.kind,
    credits: order.credits,
    base_entries: order.base_entries,
    amount_cents: order.amount_cents,
    first_name: order.name.split(' ')[0],
    balance: order.user_id ? creditBalance(order.user_id) : 0,
  };
}

router.get('/orders/:id', (req, res) => {
  res.json(orderView(loadOrder(req.params.id, req.query.t)));
});

// Fake payment used when no Yoco key is configured, so the whole flow can be tested for free.
router.post('/demo/pay', (req, res) => {
  if (yoco.mode() !== 'demo') throw httpError(404, 'Not found.');
  const order = loadOrder(req.body?.order, req.body?.t);
  markPaid(order.id, `demo_${crypto.randomBytes(6).toString('hex')}`);
  res.json({ redirectUrl: `/success?order=${order.id}&t=${order.access_token}` });
});

module.exports = router;
