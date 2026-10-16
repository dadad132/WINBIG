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

  // ------------------------------------------------------------ my tickets

  const entries = (n) => `${n} ${n === 1 ? 'entry' : 'entries'}`;
  const tag = (o) =>
    o.won
      ? html`<span class="tag won">🏆 Winner</span>`
      : {
          paid: html`<span class="tag paid">Paid</span>`,
          pending: html`<span class="tag pending">Waiting for payment</span>`,
          review: html`<span class="tag review">Payment being checked</span>`,
        }[o.status];

  function drawInfo(o) {
    if (o.won) return html`<p class="win-note">Congratulations, you won! We'll contact you to arrange your prize.</p>`;
    if (o.competition.status === 'drawn') return html`<p class="meta">The winner of this prize has been drawn.</p>`;
    if (o.competition.draw_at) return html`<p class="meta">Winner drawn ${WB.formatDate(o.competition.draw_at)}</p>`;
    return '';
  }

  try {
    const orders = await WB.api('/api/account/orders');
    setHTML(
      $('orders'),
      orders.length
        ? orders.map(
            (o) => html`<article class="order-card">
              <img src="${o.competition.image_url || '/img/prize-placeholder.svg'}" alt="">
              <div>
                ${tag(o)}
                <h3>${o.competition.title}</h3>
                <p class="meta">Order #${o.id} · ${WB.formatDate(o.created_at)} · ${money(o.amount_cents)}</p>
                ${o.status === 'paid'
                  ? html`<p class="meta"><b>${entries(o.tickets.length)}</b> (${o.base_entries} bought + ${o.bonus_entries} bonus)</p>
                         <div class="tickets">${o.tickets.map((t) => html`<span class="ticket ${t.bonus ? 'bonus' : ''}">${t.ticket}</span>`)}</div>`
                  : ''}
                ${drawInfo(o)}
                ${o.status === 'paid' && !o.spun && o.competition.status !== 'drawn'
                  ? html`<a class="btn btn-sm" href="${o.link}">Spin the wheel for bonus entries</a>`
                  : ''}
              </div>
            </article>`
          )
        : html`<div class="empty">You don't have any tickets yet.<br><br><a href="/#tickets" class="btn">Get tickets</a></div>`
    );
  } catch (err) {
    setHTML($('orders'), html`<p class="empty">${err.message}</p>`);
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
