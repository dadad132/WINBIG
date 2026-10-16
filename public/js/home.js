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

  renderAbout();
  renderContact();
  startCounter();

  const comp = state.competition;
  if (!comp) {
    for (const id of ['prize', 'spins', 'credits']) $(id).hidden = true;
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
  let phase = comp.phase; // upcoming | open | ended
  let timer;

  const spins = (n) => `${n.toLocaleString('en-ZA')} ${n === 1 ? 'spin' : 'spins'}`;
  const credits = (n) => `${n.toLocaleString('en-ZA')} ${n === 1 ? 'credit' : 'credits'}`;
  const minWin = Math.min(...state.wheel);
  const maxWin = Math.max(...state.wheel);
  $('wheel-range').textContent = minWin === maxWin ? String(minWin) : `${minWin} to ${maxWin}`;

  // ------------------------------------------------------------ live counter & about

  function startCounter() {
    if (state.registered == null) return;
    $('live-counter').hidden = false;
    let shown = 0;
    const show = (target) => {
      const from = shown;
      const started = performance.now();
      const step = (now) => {
        const t = Math.min(1, (now - started) / 900);
        shown = Math.round(from + (target - from) * (1 - (1 - t) ** 3));
        $('registered').textContent = target === 0 ? '' : shown.toLocaleString('en-ZA');
        $('registered-label').textContent =
          target === 0 ? 'Be one of the first to register!' : shown === 1 ? 'person has registered' : 'people have registered';
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    };
    show(state.registered);
    setInterval(async () => {
      try {
        const s = await WB.api('/api/public/stats');
        if (s.registered != null && s.registered !== shown) show(s.registered);
      } catch {}
    }, 15000);
  }

  function renderAbout() {
    $('about-who').textContent = state.about.who;
    $('about-what').textContent = state.about.what;
    $('about-why').textContent = state.about.why;
  }

  function renderContact() {
    const c = state.contact;
    const wa = c.whatsapp && `https://wa.me/${c.whatsapp.replace(/\D/g, '').replace(/^0/, '27')}`;
    setHTML(
      $('contact'),
      html`${c.email ? html`<a href="mailto:${c.email}">${c.email}</a>` : ''}
           ${c.phone ? html`<a href="tel:${c.phone}">${c.phone}</a>` : ''}
           ${wa ? html`<a href="${wa}" target="_blank" rel="noopener">WhatsApp us</a>` : ''}`
    );
  }

  // ------------------------------------------------------------ phases & countdown

  function showPhase() {
    $('phase-label').textContent = { upcoming: 'Coming soon', open: 'Live now', ended: 'Entries closed' }[phase];
    $('phase-label').classList.toggle('live', phase === 'open');
    $('hero-cta').hidden = phase === 'ended';

    if (phase === 'upcoming') {
      $('draw-date').textContent = `Spinning opens ${longDate(start)}. Winner drawn ${longDate(end)}. You can already buy spins.`;
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

    const closed = phase === 'ended';
    document.querySelectorAll('[data-package]').forEach((button) => {
      const pkg = state.packages.find((p) => p.id === Number(button.dataset.package));
      button.disabled = closed;
      button.textContent = closed ? 'Sales closed' : `Buy ${spins(pkg.spins)}`;
    });
    $('credits-buy').disabled = closed;
    $('credits').hidden = closed;
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

  // ------------------------------------------------------------ spin packages

  function renderPackages() {
    const perSpin = (p) => p.price_cents / p.spins;
    const worst = Math.max(state.credit_price_cents, ...state.packages.map(perSpin));
    setHTML(
      $('packages'),
      state.packages.map((p) => {
        const save = Math.round((1 - perSpin(p) / worst) * 100);
        return html`<article class="package ${p.badge ? 'featured' : ''}">
          ${p.badge ? html`<span class="badge">${p.badge}</span>` : ''}
          <div class="entries">${p.spins}</div>
          <div class="entries-label">${p.spins === 1 ? 'spin' : 'spins'}</div>
          <div class="price">${money(p.price_cents)}</div>
          <div class="per">${money(Math.round(perSpin(p)))} per spin</div>
          <div class="save">${save > 0 ? `Save ${save}%` : ''}</div>
          <div class="bonus">Wins you ${minWin * p.spins === maxWin * p.spins ? minWin * p.spins : `${minWin * p.spins} to ${maxWin * p.spins}`} entries</div>
          <button class="btn" data-package="${p.id}">Buy ${spins(p.spins)}</button>
        </article>`;
      })
    );
    $('packages').querySelectorAll('[data-package]').forEach((button) => {
      button.onclick = () => startPurchase({ kind: 'spins', pkg: state.packages.find((p) => p.id === Number(button.dataset.package)) });
    });
  }

  // ------------------------------------------------------------ credits (any amount)

  const price = state.credit_price_cents;
  const maxCredits = state.max_custom_credits;
  let creditCount = 20;

  function setCredits(n) {
    creditCount = Math.min(maxCredits, Math.max(1, Math.round(Number(n) || 1)));
    $('credits-input').value = creditCount;
    $('credits-label').textContent = `${credits(creditCount)} = ${spins(creditCount)}`;
    $('credits-price').textContent = money(creditCount * price);
    $('credits-buy').textContent = `Buy ${credits(creditCount)}`;
    document.querySelectorAll('#credit-chips button').forEach((b) => b.classList.toggle('active', Number(b.dataset.credits) === creditCount));
  }

  function setupCredits() {
    $('credit-price').textContent = money(price);
    setHTML(
      $('credit-chips'),
      [5, 10, 20, 50].filter((n) => n <= maxCredits).map((n) => html`<button type="button" data-credits="${n}">${money(n * price)}</button>`)
    );
    $('credit-chips').querySelectorAll('button').forEach((b) => (b.onclick = () => setCredits(b.dataset.credits)));
    $('credits-minus').onclick = () => setCredits(creditCount - 1);
    $('credits-plus').onclick = () => setCredits(creditCount + 1);
    $('credits-input').onchange = () => setCredits($('credits-input').value);
    $('credits-buy').onclick = () => startPurchase({ kind: 'credits', credits: creditCount });

    const best = [...state.packages].sort((a, b) => a.price_cents / a.spins - b.price_cents / b.spins)[0];
    if (best && best.price_cents / best.spins < price) {
      $('credits-hint').textContent = `Tip: the ${spins(best.spins)} package works out cheaper, at ${money(Math.round(best.price_cents / best.spins))} per spin.`;
    }
    setCredits(creditCount);
  }

  // ------------------------------------------------------------ checkout

  const dialog = $('checkout');
  const payBtn = $('pay-btn');
  let item = null; // { kind: 'spins', pkg } or { kind: 'credits', credits }

  const amountOf = (it) => (it.kind === 'spins' ? it.pkg.price_cents : it.credits * price);
  const returnLink = (it) => (it.kind === 'spins' ? `/?buy=${it.pkg.id}` : `/?credits=${it.credits}`);

  function startPurchase(it) {
    if (!user) {
      location.href = `/signup?next=${encodeURIComponent(returnLink(it))}`;
      return;
    }
    openCheckout(it);
  }

  function openCheckout(it) {
    item = it;
    const isSpins = it.kind === 'spins';
    $('checkout-title').textContent = isSpins ? 'Confirm your spins' : 'Confirm your credits';
    $('sum-what').textContent = isSpins ? spins(it.pkg.spins) : `${credits(it.credits)} (${spins(it.credits)})`;
    $('sum-price').textContent = money(amountOf(it));
    $('buyer-name').textContent = `${user.first_name} ${user.last_name} (${user.customer_no})`;
    $('buyer-contact').textContent = `${user.email} · ${user.phone}`;
    $('after-note').textContent = isSpins
      ? '🔒 Pay securely with Yoco. Afterwards you go straight to the wheel.'
      : '🔒 Pay securely with Yoco. Your credits are saved in your account.';
    payBtn.textContent = `Pay ${money(amountOf(it))}`;
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
    const body = item.kind === 'spins' ? { packageId: item.pkg.id } : { credits: item.credits };
    try {
      const { redirectUrl } = await WB.api('/api/checkout', { method: 'POST', body: { ...body, agree: $('f-agree').checked } });
      location.href = redirectUrl;
    } catch (err) {
      if (err.status === 401) {
        location.href = `/signin?next=${encodeURIComponent(returnLink(item))}`;
        return;
      }
      $('form-error').textContent = err.message;
      payBtn.disabled = false;
      payBtn.textContent = `Pay ${money(amountOf(item))}`;
    }
  });

  renderPackages();
  setupCredits();
  showPhase();

  // Coming back from sign-up with something already chosen? Open the checkout straight away.
  const params = new URLSearchParams(location.search);
  if (params.has('buy') || params.has('credits')) {
    history.replaceState(null, '', location.pathname);
    if (user && phase !== 'ended') {
      const pkg = state.packages.find((p) => p.id === Number(params.get('buy')));
      if (pkg) openCheckout({ kind: 'spins', pkg });
      else if (params.has('credits')) {
        setCredits(params.get('credits'));
        openCheckout({ kind: 'credits', credits: creditCount });
      }
    }
  }
})();
