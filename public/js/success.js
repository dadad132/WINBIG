(function () {
  const { html, setHTML, money } = WB;
  const panel = document.getElementById('panel');
  const params = new URLSearchParams(location.search);
  const orderId = params.get('order');
  const token = params.get('t');
  const cancelled = params.has('cancelled') || params.has('failed');
  const started = Date.now();
  const show = (content) => setHTML(panel, content);
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const backHome = html`<div class="actions-row"><a href="/" class="btn btn-ghost">Back to WinBig</a></div>`;
  WB.initAuthNav();

  if (!orderId || !token) {
    show(html`<h1>Order not found</h1><p>This link is incomplete. Please use the link from your payment confirmation.</p>${backHome}`);
    return;
  }

  async function poll() {
    let order;
    try {
      order = await WB.api(`/api/orders/${encodeURIComponent(orderId)}?t=${encodeURIComponent(token)}`);
    } catch (err) {
      show(html`<h1>Order not found</h1><p>${err.message}</p>${backHome}`);
      return;
    }

    if (order.status === 'paid') return showPaid(order);
    if (order.status === 'review') {
      return show(html`<h1>We're checking your payment</h1>
        <p>Your payment needs a quick manual check. We'll be in touch soon. Your order number is <b>#${order.id}</b>.</p>${backHome}`);
    }
    if (cancelled) {
      return show(html`<h1>Payment not completed</h1>
        <p>No money was taken. You can try again any time.</p>
        <div class="actions-row"><a href="/#spins" class="btn">Try again</a></div>`);
    }

    // Waiting for Yoco to confirm the payment (usually a few seconds).
    const slow = Date.now() - started > 90 * 1000;
    show(html`<div class="spinner"></div>
      <h1>Confirming your payment…</h1>
      <p>${slow
        ? html`This is taking longer than usual. Keep this page open, it updates automatically. If you were charged and nothing happens, contact us and quote order <b>#${order.id}</b>.`
        : 'Hang tight, this usually takes a few seconds.'}</p>`);
    setTimeout(poll, 2500);
  }

  function showPaid(order) {
    if (order.kind === 'entries') {
      // Orders from an older version of the site bought entries directly.
      return show(html`<p class="eyebrow">Payment received</p><h1>Thanks ${order.first_name}, you're in!</h1>
        <p>Your ${order.base_entries} ${order.base_entries === 1 ? 'entry is' : 'entries are'} in the draw.</p>
        <div class="actions-row"><a href="/account" class="btn">See my tickets</a></div>`);
    }
    const what = order.kind === 'spins' ? plural(order.credits, 'spin') : plural(order.credits, 'credit');
    show(html`<p class="eyebrow">Payment received · ${money(order.amount_cents)}</p>
      <h1>Thanks ${order.first_name}! 🎉</h1>
      <div class="big-number">${order.credits}</div>
      <p>${what} added to your account. You now have <b>${plural(order.balance, 'spin')}</b> to use.</p>
      <div class="actions-row"><a href="/spin" class="btn btn-lg">Spin the wheel</a><a href="/account" class="btn btn-ghost">My account</a></div>
      ${order.kind === 'spins' ? html`<p><small id="redirect-note">Taking you to the wheel…</small></p>` : ''}`);
    if (order.kind === 'spins') setTimeout(() => location.assign('/spin'), 2500);
  }

  poll();
})();
