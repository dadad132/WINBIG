(function () {
  const { html, setHTML, money } = WB;
  const panel = document.getElementById('panel');
  WB.initAuthNav();
  const params = new URLSearchParams(location.search);
  const orderId = params.get('order');
  const token = params.get('t');
  const cancelled = params.has('cancelled') || params.has('failed');
  const started = Date.now();
  const show = (content) => setHTML(panel, content);
  const entryWord = (n) => (n === 1 ? 'entry' : 'entries');
  const backHome = html`<div class="actions-row"><a href="/" class="btn btn-ghost">Back to WinBig</a></div>`;

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

    if (order.status === 'paid') return order.spun ? showResult(order, false) : showWheel(order);
    if (order.status === 'review') {
      return show(html`<h1>We're checking your payment</h1>
        <p>Your payment needs a quick manual check. We'll be in touch soon. Your order number is <b>#${order.id}</b>.</p>${backHome}`);
    }
    if (cancelled) {
      return show(html`<h1>Payment not completed</h1>
        <p>No money was taken and you haven't been entered. You can try again any time.</p>
        <div class="actions-row"><a href="/#tickets" class="btn">Try again</a></div>`);
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

  function showWheel(order) {
    const maxBonus = Math.max(0, ...order.wheel);
    show(html`<p class="eyebrow">Payment received</p>
      <h1>Thanks ${order.first_name}, you're in!</h1>
      <p>You have <b>${order.base_entries} ${entryWord(order.base_entries)}</b> in the draw for <b>${order.competition.title}</b>.
         Now spin the wheel to win up to <b>${maxBonus}</b> bonus entries!</p>
      <div class="wheel-area"><div id="wheel"></div></div>
      <button class="btn btn-lg" id="spin-btn">Spin the wheel!</button>
      <p class="form-error" id="spin-error"></p>`);

    const wheel = new PrizeWheel(document.getElementById('wheel'), order.wheel);
    const button = document.getElementById('spin-btn');
    button.onclick = async () => {
      button.disabled = true;
      button.textContent = 'Spinning…';
      try {
        const result = await WB.api(`/api/orders/${encodeURIComponent(orderId)}/spin`, { method: 'POST', body: { t: token } });
        if (!result.alreadySpun) await wheel.spinTo(result.bonus);
        WB.confetti();
        showResult(result.order, true);
      } catch (err) {
        document.getElementById('spin-error').textContent = err.message;
        button.textContent = 'Spin the wheel!';
        button.disabled = false;
      }
    };
  }

  function showResult(order, justSpun) {
    const total = order.tickets.length;
    const drawText = order.competition.draw_at
      ? html`The winner is drawn on <b>${WB.formatDate(order.competition.draw_at, { dateStyle: 'full', timeStyle: 'short' })}</b>.`
      : 'We will announce the draw date soon.';
    show(html`<p class="eyebrow">${justSpun ? 'You won' : "You're in the draw"}</p>
      ${justSpun && order.bonus_entries
        ? html`<h1>+${order.bonus_entries} bonus ${entryWord(order.bonus_entries)}! 🎉</h1>`
        : html`<h1>Good luck, ${order.first_name}!</h1>`}
      <div class="big-number">${total}</div>
      <p>total ${entryWord(total)} for <b>${order.competition.title}</b><br>
         (${order.base_entries} bought + ${order.bonus_entries} bonus · paid ${money(order.amount_cents)})</p>
      <div class="tickets">${order.tickets.map((t) => html`<span class="ticket ${t.bonus ? 'bonus' : ''}">${t.ticket}</span>`)}</div>
      <p>${drawText} We'll contact the winner by email and phone.</p>
      <p><small>You can see your tickets any time under <a href="/account">My tickets</a>.</small></p>
      <div class="actions-row"><a href="/#tickets" class="btn">Buy more tickets</a><a href="/" class="btn btn-ghost">Home</a></div>`);
  }

  poll();
})();
