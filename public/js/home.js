(async function () {
  const { html, setHTML, money } = WB;
  const $ = (id) => document.getElementById(id);
  $('year').textContent = new Date().getFullYear();

  const userReady = WB.initAuthNav();
  let state;
  try {
    state = await WB.api('/api/public/state');
  } catch {
    $('prize-title').textContent = 'Could not load the prize. Please refresh the page.';
    return;
  }
  const user = await userReady;

  if (state.paymentMode !== 'live') {
    $('mode-ribbon').hidden = false;
    $('mode-ribbon').textContent =
      state.paymentMode === 'demo' ? 'DEMO MODE: payments are simulated, no money is taken' : 'TEST MODE: use Yoco test cards only';
  }

  if (state.lastWinner) {
    const w = state.lastWinner;
    $('winner-banner').hidden = false;
    $('winner-banner').textContent = `🎉 Congratulations ${w.name}! Ticket ${w.ticket} won "${w.prize}".`;
  }

  const comp = state.competition;
  if (!comp || !state.packages.length) {
    $('prize').hidden = $('tickets').hidden = true;
    $('closed').hidden = false;
    return;
  }

  document.title = `${comp.title} | WinBig`;
  $('prize-title').textContent = comp.title;
  $('prize-desc').textContent = comp.description;
  if (comp.prize_value_cents > 0) {
    $('value-pill').hidden = false;
    $('prize-value').textContent = money(comp.prize_value_cents);
  }
  if (comp.image_url) $('prize-img').src = comp.image_url;
  $('prize-img').alt = comp.title;

  const start = WB.parseDate(comp.starts_at);
  const end = WB.parseDate(comp.draw_at);
  const longDate = (d) => d.toLocaleString('en-ZA', { dateStyle: 'full', timeStyle: 'short' });
  const shortDate = (d) => d.toLocaleString('en-ZA', { day: 'numeric', month: 'short' });
  let phase = comp.phase; // upcoming | open | ended
  let timer;

  const maxBonus = Math.max(0, ...state.wheel);
  $('max-bonus').textContent = maxBonus;


  // ------------------------------------------------------------ phases & countdown

  function showPhase() {
    $('phase-label').textContent = { upcoming: 'Coming soon', open: 'Live now', ended: 'Entries closed' }[phase];
    $('phase-label').classList.toggle('live', phase === 'open');
    $('hero-cta').hidden = phase === 'ended';

    if (phase === 'upcoming') {
      $('draw-date').textContent = `Entries open ${longDate(start)}. Winner drawn ${longDate(end)}.`;
      startCountdown(start, () => location.reload());
    } else if (phase === 'open') {
      $('draw-date').textContent = `Entries close and the winner is drawn ${longDate(end)}.`;
      startCountdown(end, () => {
        phase = 'ended';
        showPhase();
      });
    } else {
      $('countdown').hidden = true;
      $('draw-date').textContent = 'Entries are closed. The winner will be announced soon!';
    }

    document.querySelectorAll('[data-package]').forEach((button) => {
      const pkg = state.packages.find((p) => p.id === Number(button.dataset.package));
      button.disabled = phase !== 'open';
      button.textContent =
        phase === 'upcoming' ? `Opens ${shortDate(start)}` : phase === 'ended' ? 'Entries closed' : `Choose ${entries(pkg.entries)}`;
    });
  }

  function startCountdown(target, onDone) {
    clearInterval(timer);
    $('countdown').hidden = false;
    const pad = (n) => String(n).padStart(2, '0');
    const tick = () => {
      let s = Math.max(0, Math.floor((target - Date.now()) / 1000));
      const days = Math.floor(s / 86400);
      s %= 86400;
      const hours = Math.floor(s / 3600);
      s %= 3600;
      setHTML(
        $('countdown'),
        html`<div><b>${days}</b><span>days</span></div><div><b>${pad(hours)}</b><span>hours</span></div>
             <div><b>${pad(Math.floor(s / 60))}</b><span>mins</span></div><div><b>${pad(s % 60)}</b><span>secs</span></div>`
      );
      if (target <= Date.now()) {
        clearInterval(timer);
        onDone();
      }
    };
    timer = setInterval(tick, 1000);
    tick();
  }

  // ------------------------------------------------------------ packages

  function entries(n) {
    return `${n} ${n === 1 ? 'entry' : 'entries'}`;
  }

  function renderPackages() {
    const perEntry = (p) => p.price_cents / p.entries;
    const worst = Math.max(...state.packages.map(perEntry));
    setHTML(
      $('packages'),
      state.packages.map((p) => {
        const save = Math.round((1 - perEntry(p) / worst) * 100);
        return html`<article class="package ${p.badge ? 'featured' : ''}">
          ${p.badge ? html`<span class="badge">${p.badge}</span>` : ''}
          <div class="entries">${p.entries}</div>
          <div class="entries-label">${p.entries === 1 ? 'entry' : 'entries'}</div>
          <div class="price">${money(p.price_cents)}</div>
          <div class="per">${money(Math.round(perEntry(p)))} per entry</div>
          <div class="save">${save > 0 ? `Save ${save}%` : ''}</div>
          ${maxBonus ? html`<div class="bonus">+ free spin for up to ${maxBonus} bonus entries</div>` : ''}
          <button class="btn" data-package="${p.id}">Choose ${entries(p.entries)}</button>
        </article>`;
      })
    );
    $('packages').querySelectorAll('[data-package]').forEach((button) => {
      button.onclick = () => {
        const pkg = state.packages.find((p) => p.id === Number(button.dataset.package));
        if (!user) {
          location.href = `/signup?next=${encodeURIComponent(`/?buy=${pkg.id}`)}`;
          return;
        }
        openCheckout(pkg);
      };
    });
  }

  // ------------------------------------------------------------ checkout

  const dialog = $('checkout');
  const payBtn = $('pay-btn');
  let selected = null;

  function openCheckout(pkg) {
    selected = pkg;
    $('sum-entries').textContent = `${entries(pkg.entries)} + 1 bonus spin`;
    $('sum-price').textContent = money(pkg.price_cents);
    $('buyer-name').textContent = `${user.first_name} ${user.last_name} (${user.customer_no})`;
    $('buyer-contact').textContent = `${user.email} · ${user.phone}`;
    payBtn.textContent = `Pay ${money(pkg.price_cents)}`;
    payBtn.disabled = false;
    $('form-error').textContent = '';
    dialog.showModal();
  }

  $('close-checkout').onclick = () => dialog.close();

  $('checkout-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('form-error').textContent = '';
    payBtn.disabled = true;
    payBtn.textContent = 'Connecting to secure payment…';
    try {
      const { redirectUrl } = await WB.api('/api/checkout', {
        method: 'POST',
        body: { packageId: selected.id, agree: $('f-agree').checked },
      });
      location.href = redirectUrl;
    } catch (err) {
      if (err.status === 401) {
        location.href = `/signin?next=${encodeURIComponent(`/?buy=${selected.id}`)}`;
        return;
      }
      $('form-error').textContent = err.message;
      payBtn.disabled = false;
      payBtn.textContent = `Pay ${money(selected.price_cents)}`;
    }
  });

  renderPackages();
  showPhase();

  // Coming back from sign-up with a package already chosen? Open the checkout straight away.
  const buyId = Number(new URLSearchParams(location.search).get('buy'));
  if (buyId) {
    history.replaceState(null, '', location.pathname);
    const pkg = state.packages.find((p) => p.id === buyId);
    if (pkg && user && phase === 'open') openCheckout(pkg);
  }
})();
