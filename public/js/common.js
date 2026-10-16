/* Shared helpers for the WinBig website and admin panel. */
(function () {
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESCAPES[c]);

  // Tagged template: html`<b>${name}</b>` escapes every value, so user content can't inject HTML.
  // Nested html`` results and arrays of them are inserted as-is.
  function render(value) {
    if (value == null || value === false) return '';
    if (Array.isArray(value)) return value.map(render).join('');
    if (typeof value === 'object' && '__html' in value) return value.__html;
    return esc(value);
  }
  function html(strings, ...values) {
    let out = strings[0];
    values.forEach((v, i) => (out += render(v) + strings[i + 1]));
    return { __html: out };
  }
  const setHTML = (el, content) => (el.innerHTML = render(content));

  // 40000 -> "R400", 12550 -> "R125.50"
  function money(cents) {
    const rands = cents / 100;
    const whole = Number.isInteger(rands);
    return 'R' + rands.toLocaleString('en-ZA', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  }

  // Accepts ISO dates and SQLite "YYYY-MM-DD HH:MM:SS" (UTC) timestamps.
  const parseDate = (s) => new Date(/[TZ]/.test(s) ? s : s.replace(' ', 'T') + 'Z');
  const formatDate = (s, opts = { dateStyle: 'medium', timeStyle: 'short' }) =>
    parseDate(s).toLocaleString('en-ZA', opts);

  async function api(url, { method = 'GET', body } = {}) {
    const opts = { method, headers: {}, credentials: 'same-origin' };
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) {
      opts.body = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function confetti(count = 150) {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const colors = ['#ffc940', '#ff3d8b', '#7c5cff', '#22b8f0', '#2ee59d', '#ffffff'];
    const layer = document.createElement('div');
    layer.className = 'confetti-layer';
    document.body.appendChild(layer);
    for (let i = 0; i < count; i++) {
      const piece = document.createElement('i');
      const size = 6 + Math.random() * 8;
      piece.style.cssText = `left:${Math.random() * 100}vw;width:${size}px;height:${size * 0.45}px;background:${colors[i % colors.length]}`;
      layer.appendChild(piece);
      piece.animate(
        [
          { transform: 'translate3d(0,-10vh,0) rotate(0deg)' },
          { transform: `translate3d(${(Math.random() - 0.5) * 40}vw,110vh,0) rotate(${720 + Math.random() * 720}deg)` },
        ],
        { duration: 2600 + Math.random() * 2000, delay: Math.random() * 400, easing: 'cubic-bezier(.2,.6,.4,1)', fill: 'forwards' }
      );
    }
    setTimeout(() => layer.remove(), 5200);
  }

  // Fills the header with Sign in / Sign up, or My tickets / Sign out. Resolves to the signed-in customer (or null).
  async function initAuthNav() {
    let user = null;
    try {
      user = (await api('/api/account/me')).user;
    } catch {}
    const slot = document.getElementById('auth-nav');
    if (slot) {
      const next = encodeURIComponent(location.pathname + location.search);
      setHTML(
        slot,
        user
          ? html`<a href="/account" class="btn btn-sm">My tickets</a>
                 <button type="button" class="btn btn-sm btn-ghost" data-signout>Sign out</button>`
          : html`<a href="/signin?next=${next}" class="btn btn-sm btn-ghost">Sign in</a>
                 <a href="/signup?next=${next}" class="btn btn-sm">Sign up</a>`
      );
      const signOut = slot.querySelector('[data-signout]');
      if (signOut) {
        signOut.onclick = async () => {
          await api('/api/account/signout', { method: 'POST' }).catch(() => {});
          location.href = '/';
        };
      }
    }
    return user;
  }

  window.WB = { esc, html, setHTML, money, parseDate, formatDate, api, confetti, initAuthNav };
})();
