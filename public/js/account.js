(async function () {
  const { html, setHTML, money } = WB;
  const $ = (id) => document.getElementById(id);

  let user = await WB.initAuthNav();
  if (!user) {
    location.replace('/signin?next=/account');
    return;
  }
  $('account').hidden = false;

  function showUser() {
    $('hello').textContent = `Hi ${user.first_name}`;
    $('customer-no').textContent = user.customer_no;
    $('d-first').value = user.first_name;
    $('d-last').value = user.last_name;
    $('d-email').value = user.email;
    $('d-phone').value = user.phone;
  }
  showUser();

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const entries = (n) => `${n} ${n === 1 ? 'entry' : 'entries'}`;

  // ------------------------------------------------------------ credits, tickets & purchases

  function statusTag(c) {
    if (c.won) return html`<span class="tag won">🏆 Winner</span>`;
    if (c.status === 'drawn') return html`<span class="tag done">Winner drawn</span>`;
    return html`<span class="tag paid">In the draw</span>`;
  }

  function drawInfo(c) {
    if (c.won) return html`<p class="win-note">Congratulations, you won! We'll contact you to arrange your prize.</p>`;
    if (c.status === 'drawn') return html`<p class="meta">The winner of this prize has been drawn.</p>`;
    if (c.draw_at) return html`<p class="meta">Winner drawn ${WB.formatDate(c.draw_at)}</p>`;
    return '';
  }

  function ticketList(c) {
    const chips = c.tickets.map((t) => html`<span class="ticket">${t}</span>`);
    if (c.tickets.length <= 12) return html`<div class="tickets">${chips}</div>`;
    return html`<details class="ticket-details"><summary>Show all ${c.entries} ticket numbers</summary><div class="tickets">${chips}</div></details>`;
  }

  function purchaseLabel(p) {
    if (p.kind === 'spins') return plural(p.credits, 'spin');
    if (p.kind === 'credits') return plural(p.credits, 'credit');
    return entries(p.base_entries);
  }
  const purchaseStatus = { paid: 'Paid', pending: 'Waiting for payment', review: 'Payment being checked' };

  try {
    const data = await WB.api('/api/account/overview');
    $('credit-count').textContent = data.credits;
    $('spin-link').hidden = data.credits === 0;

    setHTML(
      $('competitions'),
      data.competitions.length
        ? data.competitions.map(
            (c) => html`<article class="order-card">
              <img src="${c.image_url || '/img/prize-placeholder.svg'}" alt="">
              <div>
                ${statusTag(c)}
                <h3>${c.title}</h3>
                <p class="meta"><b>${entries(c.entries)}</b> in this draw</p>
                ${ticketList(c)}
                ${drawInfo(c)}
              </div>
            </article>`
          )
        : html`<div class="empty">You don't have any tickets yet. Spin the wheel to win entries!<br><br>
            <a href="${data.credits ? '/spin' : '/#spins'}" class="btn">${data.credits ? 'Spin the wheel' : 'Buy spins'}</a></div>`
    );

    setHTML(
      $('purchases'),
      data.purchases.length
        ? html`<table><thead><tr><th>Date</th><th>What</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>${data.purchases.map(
              (p) => html`<tr><td>${WB.formatDate(p.created_at, { dateStyle: 'medium' })}</td><td>${purchaseLabel(p)}</td>
                <td>${money(p.amount_cents)}</td><td><span class="tag ${p.status}">${purchaseStatus[p.status] || p.status}</span></td></tr>`
            )}</tbody></table>`
        : html`<p class="empty">No purchases yet.</p>`
    );
  } catch (err) {
    setHTML($('competitions'), html`<p class="empty">${err.message}</p>`);
  }

  // ------------------------------------------------------------ details & password

  async function submit(form, errorEl, okEl, request) {
    const button = form.querySelector('button');
    errorEl.textContent = okEl.textContent = '';
    button.disabled = true;
    try {
      okEl.textContent = await request();
    } catch (err) {
      errorEl.textContent = err.message;
    }
    button.disabled = false;
  }

  $('details-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submit(e.target, $('details-error'), $('details-ok'), async () => {
      ({ user } = await WB.api('/api/account/me', {
        method: 'PUT',
        body: { first_name: $('d-first').value, last_name: $('d-last').value, email: $('d-email').value, phone: $('d-phone').value },
      }));
      showUser();
      return 'Your details have been saved.';
    });
  });

  $('password-form').addEventListener('submit', (e) => {
    e.preventDefault();
    submit(e.target, $('password-error'), $('password-ok'), async () => {
      await WB.api('/api/account/password', { method: 'PUT', body: { current: $('p-current').value, password: $('p-new').value } });
      e.target.reset();
      return 'Your password has been changed.';
    });
  });
})();
