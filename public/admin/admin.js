(function () {
  const { html, setHTML, money, formatDate } = WB;
  const view = document.getElementById('view');
  const modal = document.getElementById('modal');
  const toastEl = document.getElementById('toast');

  // ------------------------------------------------------------------ helpers

  let toastTimer;
  function toast(message, isError = false) {
    toastEl.textContent = message;
    toastEl.className = 'show' + (isError ? ' error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.className = ''), 3600);
  }

  async function api(url, opts) {
    try {
      return await WB.api(url, opts);
    } catch (err) {
      if (err.status === 401) location.href = '/admin/login';
      throw err;
    }
  }

  const pill = (status, label = status) => html`<span class="pill ${status}">${label.charAt(0).toUpperCase() + label.slice(1)}</span>`;
  const PHASES = {
    draft: 'Draft',
    scheduled: 'Scheduled',
    live: 'Live now',
    ended: 'Ended: ready to draw',
    closed: 'Closed',
    drawn: 'Winner drawn',
  };
  const phasePill = (c) => pill(c.phase, PHASES[c.phase]);
  const paidOrders = (n) => `${n} paid order${n === 1 ? '' : 's'}`;
  const entries = (n) => `${n} ${n === 1 ? 'entry' : 'entries'}`;
  const percent = (fraction) => `${Math.round(fraction * 1000) / 10}%`;
  const prizeImg = (c) => c.image_url || '/img/prize-placeholder.svg';
  const dates = (c) =>
    c.starts_at && c.draw_at ? `${formatDate(c.starts_at)} → ${formatDate(c.draw_at)}` : 'No dates set';

  // 082 123 4567 -> https://wa.me/27821234567
  function whatsappLink(phone) {
    let digits = String(phone).replace(/\D/g, '');
    if (digits.startsWith('0')) digits = '27' + digits.slice(1);
    return `https://wa.me/${digits}`;
  }

  // datetime-local <-> ISO
  function toLocalInput(value) {
    if (!value) return '';
    const d = value instanceof Date ? value : new Date(value);
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
  const fromLocalInput = (value) => (value ? new Date(value).toISOString() : '');

  modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) modal.close();
  });

  function bought(o) {
    if (o.kind === 'spins') return `${o.credits} ${o.credits === 1 ? 'spin' : 'spins'}`;
    if (o.kind === 'credits') return `${o.credits} ${o.credits === 1 ? 'credit' : 'credits'}`;
    return entries(o.base_entries + o.bonus_entries); // older orders bought entries directly
  }

  function ordersTable(rows) {
    if (!rows.length) return html`<p class="hint">No orders yet.</p>`;
    return html`<div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Date</th><th>Customer</th><th>Bought</th><th>Amount</th><th>Status</th><th>Tickets</th></tr></thead>
      <tbody>${rows.map(
        (o) => html`<tr>
          <td>${o.id}</td>
          <td>${formatDate(o.created_at)}</td>
          <td><b>${o.name}</b> ${o.customer_no ? html`<span class="hint mono">${o.customer_no}</span>` : ''}<br>
              <span class="hint">${o.email} · ${o.phone}</span></td>
          <td>${bought(o)}</td>
          <td>${money(o.amount_cents)}</td>
          <td>${pill(o.status, o.status === 'pending' ? 'awaiting payment' : o.status)}</td>
          <td>${o.tickets.length
            ? html`<details><summary>${o.tickets.length} tickets</summary><div class="ticket-list">${o.tickets.map(
                (t, i) => html`<span class="${i >= o.base_entries ? 'bonus' : ''}">${t}</span>`
              )}</div></details>`
            : html`<span class="hint">–</span>`}</td>
        </tr>`
      )}</tbody></table></div>`;
  }

  // ------------------------------------------------------------------ dashboard

  async function dashboard() {
    const s = await api('/api/admin/stats');
    const c = s.current;
    setHTML(view, html`
      <div class="page-head"><div><h1>Dashboard</h1><p>Sales overview and the prize that's on the website.</p></div></div>
      <div class="stats">
        <div class="stat"><span>Total revenue</span><b>${money(s.revenue_cents)}</b></div>
        <div class="stat"><span>Paid orders</span><b>${s.paid_orders}</b></div>
        <div class="stat"><span>Customers</span><b>${s.customers}</b></div>
        <div class="stat"><span>Entries for current prize</span><b>${c ? c.entries : '–'}</b></div>
        <div class="stat"><span>Spins not used yet</span><b>${s.credits_unused}</b></div>
      </div>
      ${s.review_orders
        ? html`<div class="alert error"><b>${s.review_orders} order(s) need review:</b> the amount paid didn't match the package price.
            Check them on the <a href="#orders">Orders</a> page (status "review") and in your Yoco portal.</div>`
        : ''}
      ${c
        ? html`<div class="card live-prize">
            <img src="${prizeImg(c)}" alt="">
            <div>
              ${phasePill(c)}
              <h2>${c.title}</h2>
              <p>Worth ${money(c.prize_value_cents)} · ${dates(c)}</p>
              <p>${paidOrders(c.paid_orders)} · ${entries(c.entries)} · ${money(c.revenue_cents)} revenue</p>
              ${c.phase === 'ended' ? html`<p><a href="#draw">Go and draw the winner →</a></p>` : ''}
            </div>
          </div>`
        : html`<div class="alert">There's no prize on the website, so visitors can't buy tickets. Go to <a href="#prizes">Prizes</a>
            and publish one with a start and end date.</div>`}
      <div class="card"><h2>Latest orders</h2>${ordersTable(s.recent)}</div>`);
  }

  // ------------------------------------------------------------------ prizes

  async function prizes() {
    const list = await api('/api/admin/competitions');
    setHTML(view, html`
      <div class="page-head">
        <div><h1>Prizes</h1><p>Give each prize a start and end date. A published prize goes live on the website at its start date,
          and ticket sales close at its end date. You can schedule the next prize in advance; dates may not overlap.</p></div>
        <button class="btn primary" id="new-prize">+ New prize</button>
      </div>
      <div class="card">${list.length
        ? html`<div class="table-wrap"><table>
            <thead><tr><th></th><th>Prize</th><th>Value</th><th>Start</th><th>End</th><th>Status</th><th>Entries</th><th>Revenue</th><th></th></tr></thead>
            <tbody>${list.map(
              (c) => html`<tr>
                <td><img class="thumb" src="${prizeImg(c)}" alt=""></td>
                <td><b>${c.title}</b></td>
                <td>${money(c.prize_value_cents)}</td>
                <td>${c.starts_at ? formatDate(c.starts_at) : '–'}</td>
                <td>${c.draw_at ? formatDate(c.draw_at) : '–'}</td>
                <td>${phasePill(c)}</td>
                <td>${c.entries}</td>
                <td>${money(c.revenue_cents)}</td>
                <td class="actions">
                  <button class="btn small" data-edit="${c.id}">Edit</button>
                  ${c.all_orders ? '' : html`<button class="btn small danger" data-delete="${c.id}">Delete</button>`}
                </td>
              </tr>`
            )}</tbody></table></div>`
        : html`<p class="hint">No prizes yet. Click "New prize" to add one.</p>`}</div>`);

    document.getElementById('new-prize').onclick = () => prizeForm(null, list);
    view.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = () => prizeForm(list.find((c) => c.id === Number(b.dataset.edit)), list);
    });
    view.querySelectorAll('[data-delete]').forEach((b) => {
      b.onclick = async () => {
        if (!confirm('Delete this prize? This cannot be undone.')) return;
        try {
          await api(`/api/admin/competitions/${b.dataset.delete}`, { method: 'DELETE' });
          toast('Prize deleted');
          prizes();
        } catch (err) {
          toast(err.message, true);
        }
      };
    });
  }

  function prizeForm(c, list) {
    const drawn = c?.status === 'drawn';

    // New prizes start when the last scheduled one ends (or now) and run for 30 days.
    let start = c?.starts_at;
    let end = c?.draw_at;
    if (!c) {
      const lastEnd = list
        .filter((p) => p.status === 'active' && p.draw_at)
        .reduce((latest, p) => Math.max(latest, Date.parse(p.draw_at)), 0);
      const from = new Date(Math.max(Date.now(), lastEnd));
      from.setSeconds(0, 0);
      const to = new Date(from.getTime() + 30 * 24 * 3600 * 1000);
      to.setHours(19, 0, 0, 0);
      start = from;
      end = to;
    }

    setHTML(modal, html`<form id="prize-form">
      <h2>${c ? 'Edit prize' : 'New prize'}</h2>
      <label>Prize name<input name="title" required maxlength="120" value="${c?.title || ''}" placeholder="e.g. Brand new iPhone 17 Pro"></label>
      <label>Prize value (R)<input name="prize_value" type="number" min="0" step="0.01" required value="${c ? c.prize_value_cents / 100 : ''}" placeholder="25000"></label>
      <div class="row">
        <label>Start date &amp; time <span class="hint">(entries open)</span>
          <input name="starts_at" type="datetime-local" value="${toLocalInput(start)}"></label>
        <label>End date &amp; time <span class="hint">(entries close)</span>
          <input name="draw_at" type="datetime-local" value="${toLocalInput(end)}"></label>
      </div>
      <label>Description <span class="hint">(shown on the website)</span>
        <textarea name="description" rows="4" maxlength="5000">${c?.description || ''}</textarea></label>
      <label>Status ${drawn ? html`<span class="hint">(the winner has been drawn)</span>` : ''}
        <select name="status" ${drawn ? 'disabled' : ''}>
          <option value="active">Published: on the website from the start date to the end date</option>
          <option value="draft">Draft: hidden while you prepare it</option>
          <option value="closed">Closed: stop ticket sales now</option>
          ${drawn ? html`<option value="drawn">Winner drawn</option>` : ''}
        </select></label>
      <label>Prize photo <span class="hint">(JPG, PNG or WEBP, max 8 MB. A 4:3 landscape photo looks best.)</span>
        <input name="image" type="file" accept="image/jpeg,image/png,image/webp,image/gif"></label>
      <img class="img-preview" id="img-preview" src="${c?.image_url || ''}" alt="" ${c?.image_url ? '' : 'hidden'}>
      <p class="form-error" id="form-error"></p>
      <div class="form-actions">
        <button type="button" class="btn" data-close>Cancel</button>
        <button class="btn primary" id="save-prize">Save prize</button>
      </div>
    </form>`);

    const form = modal.querySelector('form');
    form.elements.status.value = c?.status || 'active';
    form.elements.image.onchange = () => {
      const file = form.elements.image.files[0];
      const img = modal.querySelector('#img-preview');
      if (file) {
        img.src = URL.createObjectURL(file);
        img.hidden = false;
      }
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const data = new FormData(form);
      data.set('starts_at', fromLocalInput(form.elements.starts_at.value));
      data.set('draw_at', fromLocalInput(form.elements.draw_at.value));
      if (!form.elements.image.files.length) data.delete('image');

      const button = modal.querySelector('#save-prize');
      button.disabled = true;
      try {
        await api(c ? `/api/admin/competitions/${c.id}` : '/api/admin/competitions', { method: c ? 'PUT' : 'POST', body: data });
        modal.close();
        toast('Prize saved');
        prizes();
      } catch (err) {
        modal.querySelector('#form-error').textContent = err.message;
        button.disabled = false;
      }
    };
    modal.showModal();
  }

  // ------------------------------------------------------------------ ticket packages

  async function packages() {
    const [list, site] = await Promise.all([api('/api/admin/packages'), api('/api/admin/site')]);
    setHTML(view, html`
      <div class="page-head">
        <div><h1>Prices</h1><p>Customers buy <b>spins</b> in packages, or any number of <b>credits</b>. 1 credit = 1 spin.
          Every spin turns the <a href="#wheel">wheel</a> once. Changes show on the website straight away.</p></div>
      </div>
      <div class="card">
        <h2>Price of one credit</h2>
        <form id="credit-form" class="inline-form">
          <label>Rand per credit<input name="credit_price" type="number" min="2" step="1" value="${site.credit_price_cents / 100}"></label>
          <button class="btn primary">Save</button>
          <span class="hint" id="credit-example"></span>
        </form>
      </div>
      <div class="card">
        <div class="card-head"><h2>Spin packages</h2><button class="btn primary small" id="add-package">+ Add package</button></div>
        <div class="table-wrap"><table>
          <thead><tr><th>Price (R)</th><th>Spins</th><th>Per spin</th><th>Badge <span class="hint">(optional)</span></th><th>On website</th><th></th></tr></thead>
          <tbody id="package-rows"></tbody>
        </table></div>
      </div>`);
    const tbody = document.getElementById('package-rows');
    list.forEach((p) => tbody.appendChild(packageRow(p)));
    document.getElementById('add-package').onclick = () => tbody.appendChild(packageRow(null));

    const form = document.getElementById('credit-form');
    const example = () => {
      const price = Number(form.elements.credit_price.value) || 0;
      document.getElementById('credit-example').textContent = price > 0 ? `So R${(price * 20).toLocaleString('en-ZA')} buys 20 credits.` : '';
    };
    example();
    form.elements.credit_price.oninput = example;
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/api/admin/site', { method: 'PUT', body: { credit_price: form.elements.credit_price.value } });
        toast('Credit price saved');
      } catch (err) {
        toast(err.message, true);
      }
    };
  }

  function packageRow(pkg) {
    const tr = document.createElement('tr');
    setHTML(tr, html`
      <td><input name="price" type="number" min="2" step="1" value="${pkg ? pkg.price_cents / 100 : ''}" placeholder="100"></td>
      <td><input name="spins" type="number" min="1" step="1" value="${pkg ? pkg.spins : ''}" placeholder="1"></td>
      <td class="per"></td>
      <td><input name="badge" maxlength="30" value="${pkg?.badge || ''}" placeholder="e.g. Popular"></td>
      <td><input name="active" type="checkbox" ${!pkg || pkg.active ? 'checked' : ''}></td>
      <td class="actions"><button class="btn small primary" data-save>Save</button> <button class="btn small danger" data-remove>Delete</button></td>`);
    const field = (name) => tr.querySelector(`[name=${name}]`);
    const updatePer = () => {
      const price = Number(field('price').value);
      const count = Number(field('spins').value);
      tr.querySelector('.per').textContent = price > 0 && count > 0 ? money(Math.round((price * 100) / count)) : '–';
    };
    updatePer();
    tr.addEventListener('input', updatePer);

    tr.querySelector('[data-save]').onclick = async () => {
      const body = {
        price: field('price').value,
        spins: Number(field('spins').value),
        badge: field('badge').value,
        active: field('active').checked,
      };
      try {
        if (pkg) await api(`/api/admin/packages/${pkg.id}`, { method: 'PUT', body });
        else pkg = { id: (await api('/api/admin/packages', { method: 'POST', body })).id };
        toast('Package saved');
      } catch (err) {
        toast(err.message, true);
      }
    };
    tr.querySelector('[data-remove]').onclick = async () => {
      if (pkg && !confirm('Delete this package? (Past orders are not affected.)')) return;
      try {
        if (pkg) await api(`/api/admin/packages/${pkg.id}`, { method: 'DELETE' });
        tr.remove();
        toast('Package deleted');
      } catch (err) {
        toast(err.message, true);
      }
    };
    return tr;
  }

  // ------------------------------------------------------------------ bonus spin wheel

  async function wheel() {
    const segments = await api('/api/admin/wheel');
    setHTML(view, html`
      <div class="page-head"><div><h1>Spin wheel</h1>
        <p>Every spin (1 credit) turns this wheel once and wins the number of entries it lands on.
           The chance weight controls how often each result comes up. Customers only see the numbers, never the chances.</p></div></div>
      <div class="wheel-layout">
        <div class="card">
          <table>
            <thead><tr><th>Entries won</th><th>Chance weight</th><th>Chance</th><th></th></tr></thead>
            <tbody id="seg-rows"></tbody>
          </table>
          <p class="hint" id="wheel-summary"></p>
          <div class="form-actions" style="justify-content: space-between">
            <button class="btn" id="add-seg">+ Add segment</button>
            <button class="btn primary" id="save-wheel">Save wheel</button>
          </div>
        </div>
        <div class="card dark-card">
          <h2>Preview</h2>
          <div id="wheel-preview"></div>
          <button class="btn" id="test-spin">Test spin</button>
          <p class="hint">Test spins only show the animation and don't change anything.</p>
        </div>
      </div>`);

    const rows = document.getElementById('seg-rows');
    const preview = new PrizeWheel(document.getElementById('wheel-preview'), []);
    const read = () =>
      [...rows.querySelectorAll('tr')].map((tr) => ({
        value: Number(tr.querySelector('[name=value]').value),
        weight: Number(tr.querySelector('[name=weight]').value),
      }));

    function refresh() {
      const segs = read();
      const total = segs.reduce((sum, s) => sum + Math.max(0, s.weight), 0);
      rows.querySelectorAll('.chance').forEach((cell, i) => {
        cell.textContent = total ? percent(Math.max(0, segs[i].weight) / total) : '–';
      });
      const live = segs.filter((s) => s.weight > 0 && s.value > 0);
      const average = total ? live.reduce((sum, s) => sum + s.value * s.weight, 0) / total : 0;
      document.getElementById('wheel-summary').textContent = total
        ? `On average a spin wins ${average.toFixed(2)} entries. Segments with weight 0 are left off the wheel.`
        : 'Give at least one segment a weight above 0.';
      preview.setValues(live.map((s) => s.value));
    }

    function addRow(s = { value: 1, weight: 10 }) {
      const tr = document.createElement('tr');
      setHTML(tr, html`
        <td><input name="value" type="number" min="1" max="100" step="1" value="${s.value}"></td>
        <td><input name="weight" type="number" min="0" max="1000" step="1" value="${s.weight}"></td>
        <td class="chance"></td>
        <td class="actions"><button class="btn small danger" title="Remove segment">✕</button></td>`);
      tr.querySelector('button').onclick = () => {
        tr.remove();
        refresh();
      };
      rows.appendChild(tr);
    }

    segments.forEach((s) => addRow(s));
    refresh();
    rows.addEventListener('input', refresh);
    document.getElementById('add-seg').onclick = () => {
      addRow();
      refresh();
    };
    document.getElementById('save-wheel').onclick = async () => {
      try {
        await api('/api/admin/wheel', { method: 'PUT', body: { segments: read() } });
        toast('Wheel saved');
      } catch (err) {
        toast(err.message, true);
      }
    };
    document.getElementById('test-spin').onclick = async (e) => {
      const live = read().filter((s) => s.weight > 0);
      if (!live.length) return;
      let r = Math.random() * live.reduce((sum, s) => sum + s.weight, 0);
      const pick = live.find((s) => (r -= s.weight) < 0) || live[live.length - 1];
      e.target.disabled = true;
      await preview.spinTo(pick.value, { duration: 4000, turns: 5 });
      e.target.disabled = false;
      toast(`Landed on +${pick.value}`);
    };
  }

  // ------------------------------------------------------------------ customers

  async function customers() {
    setHTML(view, html`
      <div class="page-head">
        <div><h1>Customers</h1><p>Everyone who has signed up. Each customer has their own customer ID, and every entry they buy
          is linked to it.</p></div>
        <a class="btn" id="customers-csv" href="/api/admin/customers.csv">Download CSV</a>
      </div>
      <div class="card">
        <div class="filters"><input id="c-q" type="search" placeholder="Search name, surname, email, phone or customer ID (WBC-…)"></div>
        <div id="customer-list"><p class="hint">Loading…</p></div>
      </div>`);

    const $ = (id) => document.getElementById(id);
    async function load() {
      const q = $('c-q').value.trim();
      const params = new URLSearchParams(q ? { q } : {});
      $('customers-csv').href = `/api/admin/customers.csv?${params}`;
      const list = await api(`/api/admin/customers?${params}`);
      setHTML(
        $('customer-list'),
        list.length
          ? html`<div class="table-wrap"><table>
              <thead><tr><th>Customer ID</th><th>First name</th><th>Surname</th><th>Email</th><th>Phone</th><th>Signed up</th>
                <th>Credits</th><th>Entries</th><th>Spent</th><th></th></tr></thead>
              <tbody>${list.map(
                (c) => html`<tr>
                  <td class="mono">${c.customer_no}</td>
                  <td>${c.first_name}</td>
                  <td>${c.last_name}</td>
                  <td><a href="mailto:${c.email}">${c.email}</a></td>
                  <td><a href="tel:${c.phone}">${c.phone}</a></td>
                  <td class="nowrap">${formatDate(c.created_at, { dateStyle: 'medium' })}</td>
                  <td>${c.credits}</td>
                  <td>${c.entries}</td>
                  <td>${money(c.spent_cents)}</td>
                  <td class="actions"><button class="btn small" data-credits="${c.id}">Credits</button>
                    <button class="btn small" data-reset="${c.id}" title="Reset password">Password</button></td>
                </tr>`
              )}</tbody></table></div>`
          : html`<p class="hint">${q ? 'No customers match your search.' : 'Nobody has signed up yet.'}</p>`
      );
      $('customer-list').querySelectorAll('[data-credits]').forEach((button) => {
        const c = list.find((x) => x.id === Number(button.dataset.credits));
        button.onclick = async () => {
          const answer = prompt(
            `${c.first_name} ${c.last_name} has ${c.credits} credits.\n` +
              'How many credits do you want to add? Use a minus sign to take credits away (for example -2).'
          );
          if (!answer) return;
          const note = prompt('Reason (optional, e.g. "refund" or "Facebook competition"):') || '';
          try {
            const r = await api(`/api/admin/customers/${c.id}/credits`, { method: 'POST', body: { change: Number(answer), note } });
            toast(`${c.first_name} now has ${r.credits} credits`);
            load();
          } catch (err) {
            toast(err.message, true);
          }
        };
      });
      $('customer-list').querySelectorAll('[data-reset]').forEach((button) => {
        const c = list.find((x) => x.id === Number(button.dataset.reset));
        button.onclick = async () => {
          const password = prompt(`Type a new password for ${c.first_name} ${c.last_name} (at least 8 characters).\nThen tell them the new password.`);
          if (!password) return;
          try {
            await api(`/api/admin/customers/${c.id}/password`, { method: 'PUT', body: { password } });
            toast(`Password changed for ${c.first_name}`);
          } catch (err) {
            toast(err.message, true);
          }
        };
      });
    }
    let debounce;
    $('c-q').oninput = () => {
      clearTimeout(debounce);
      debounce = setTimeout(load, 300);
    };
    load();
  }

  // ------------------------------------------------------------------ orders

  async function orders() {
    const comps = await api('/api/admin/competitions');
    setHTML(view, html`
      <div class="page-head">
        <div><h1>Orders</h1><p>Everyone who started a purchase. Only <b>paid</b> orders have tickets in the draw.</p></div>
        <a class="btn" id="csv" href="/api/admin/orders.csv">Download CSV</a>
      </div>
      <div class="card">
        <div class="filters">
          <select id="f-comp"><option value="">All prizes</option>${comps.map((c) => html`<option value="${c.id}">${c.title}</option>`)}</select>
          <select id="f-status">
            <option value="">All statuses</option>
            <option value="paid">Paid</option>
            <option value="pending">Awaiting payment</option>
            <option value="review">Needs review</option>
          </select>
          <input id="f-q" type="search" placeholder="Search name, email, phone, order #, ticket # or customer ID">
        </div>
        <div id="order-list"><p class="hint">Loading…</p></div>
      </div>`);

    const $ = (id) => document.getElementById(id);
    async function load() {
      const params = new URLSearchParams();
      if ($('f-comp').value) params.set('competition', $('f-comp').value);
      if ($('f-status').value) params.set('status', $('f-status').value);
      if ($('f-q').value.trim()) params.set('q', $('f-q').value.trim());
      $('csv').href = `/api/admin/orders.csv?${params}`;
      const list = await api(`/api/admin/orders?${params}`);
      setHTML($('order-list'), html`
        ${list.length >= 500 ? html`<p class="hint">Showing the latest 500 orders. Use the filters, or download the CSV for everything.</p>` : ''}
        ${ordersTable(list)}`);
    }
    let debounce;
    $('f-comp').onchange = $('f-status').onchange = load;
    $('f-q').oninput = () => {
      clearTimeout(debounce);
      debounce = setTimeout(load, 300);
    };
    load();
  }

  // ------------------------------------------------------------------ draw winner (wheel)

  // The winner wheel: one slice per participant, sized by their number of entries.
  class DrawWheel {
    static COLORS = [
      { fill: '#ffc940', text: '#2a1a00' },
      { fill: '#ff3d8b', text: '#ffffff' },
      { fill: '#7c5cff', text: '#ffffff' },
      { fill: '#22b8f0', text: '#ffffff' },
      { fill: '#2ee59d', text: '#05301f' },
      { fill: '#ff8a3d', text: '#2a1200' },
    ];

    constructor(container, people) {
      this.container = container;
      this.rotation = 0;
      container.classList.add('wheel');
      container.innerHTML =
        '<div class="wheel-pointer"></div><div class="wheel-rotor"><canvas></canvas></div><div class="wheel-hub">WIN<br>BIG</div>';
      this.rotor = container.querySelector('.wheel-rotor');
      this.canvas = container.querySelector('canvas');

      const total = people.reduce((sum, p) => sum + p.entries, 0);
      let angle = 0;
      this.slices = people.map((p) => {
        const sweep = (p.entries / total) * 360;
        const slice = { ...p, start: angle, sweep };
        angle += sweep;
        return slice;
      });
      this.draw();

      const onResize = () => (container.isConnected ? this.draw() : window.removeEventListener('resize', onResize));
      window.addEventListener('resize', onResize);
      if (document.fonts) document.fonts.ready.then(() => this.draw());
    }

    draw() {
      const size = this.container.clientWidth || 360;
      const dpr = window.devicePixelRatio || 1;
      const canvas = this.canvas;
      canvas.width = canvas.height = size * dpr;
      canvas.style.width = canvas.style.height = size + 'px';
      const ctx = canvas.getContext('2d');
      ctx.scale(dpr, dpr);
      ctx.translate(size / 2, size / 2);

      const r = size / 2;
      const inner = r - size * 0.06;
      const rad = (deg) => ((deg - 90) * Math.PI) / 180; // 0° = top, clockwise
      const colors = DrawWheel.COLORS;

      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fillStyle = '#1b1f4d';
      ctx.fill();

      this.slices.forEach((s, i) => {
        // avoid the same colour on both sides of the join between the last and first slice
        let color = colors[i % colors.length];
        if (i === this.slices.length - 1 && i > 0 && i % colors.length === 0) color = colors[2];

        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, inner, rad(s.start), rad(s.start + s.sweep));
        ctx.closePath();
        ctx.fillStyle = color.fill;
        ctx.fill();
        if (this.slices.length > 1) {
          ctx.strokeStyle = 'rgba(0,0,0,.2)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // Label the slice if there's room: "Thabo M. (12)"
        const arcLength = ((s.sweep * Math.PI) / 180) * inner * 0.62;
        const fontSize = Math.min(size * 0.042, arcLength * 0.55);
        if (fontSize < 8) return;
        const parts = s.name.trim().split(/\s+/);
        let label = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
        label += ` (${s.entries})`;
        const middle = s.start + s.sweep / 2;
        const flip = middle > 180; // names on the left half would otherwise be upside down
        ctx.save();
        ctx.rotate(rad(middle) + (flip ? Math.PI : 0));
        ctx.textAlign = flip ? 'left' : 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = color.text;
        ctx.font = `700 ${fontSize}px Outfit, system-ui, sans-serif`;
        const maxWidth = inner * 0.66;
        while (label.length > 3 && ctx.measureText(label).width > maxWidth) label = label.slice(0, -2) + '…';
        ctx.fillText(label, (flip ? -1 : 1) * (inner - size * 0.04), 0);
        ctx.restore();
      });

      const bulbs = 32;
      for (let i = 0; i < bulbs; i++) {
        const a = (i / bulbs) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(Math.cos(a) * (r - size * 0.03), Math.sin(a) * (r - size * 0.03), size * 0.01, 0, Math.PI * 2);
        ctx.fillStyle = i % 2 ? '#ffe9a8' : '#ffffff';
        ctx.fill();
      }
    }

    // Turns the wheel until the given participant's slice is under the pointer.
    spinTo(key, { duration = 7000, turns = 8 } = {}) {
      const slice = this.slices.find((s) => s.key === key);
      if (!slice) return Promise.resolve();
      const landing = slice.start + slice.sweep * (0.15 + Math.random() * 0.7);
      const target = (((360 - landing) % 360) + 360) % 360;
      const current = ((this.rotation % 360) + 360) % 360;
      this.rotation += turns * 360 + ((target - current + 360) % 360);

      const ms = matchMedia('(prefers-reduced-motion: reduce)').matches ? Math.min(duration, 600) : duration;
      this.rotor.style.transition = ms ? `transform ${ms}ms cubic-bezier(.1,.7,.05,1)` : 'none';
      this.rotor.style.transform = `rotate(${this.rotation}deg)`;
      return new Promise((resolve) => setTimeout(resolve, ms + 100));
    }
  }

  async function draw() {
    const comps = await api('/api/admin/competitions');
    if (!comps.length) {
      setHTML(view, html`<div class="page-head"><div><h1>Draw a winner</h1></div></div><p>Create a prize first.</p>`);
      return;
    }
    const initial =
      comps.find((c) => c.phase === 'ended') || comps.find((c) => c.phase === 'live') || comps.find((c) => c.phase === 'closed') || comps[0];
    setHTML(view, html`
      <div class="page-head"><div><h1>Draw a winner</h1>
        <p>Every entry is one ticket, so people with more entries get a bigger slice of the wheel and a bigger chance to win.
           When you spin, the computer picks one ticket completely at random and the wheel stops on the person it belongs to.
           Tip: record your screen or go live on social media so everyone can see the draw is fair.</p></div></div>
      <div class="card"><label style="margin:0">Prize
        <select id="d-comp">${comps.map((c) => html`<option value="${c.id}">${c.title} (${PHASES[c.phase]})</option>`)}</select></label></div>
      <div id="draw-area"></div>`);
    const select = document.getElementById('d-comp');
    select.value = initial.id;
    select.onchange = () => renderDraw(comps.find((c) => c.id === Number(select.value)));
    renderDraw(initial);
  }

  function winnerCard(d) {
    return html`<div class="winner-card">
      ${pill('ok', '🏆 Winner')}
      <h2>${d.first_name} ${d.last_name}</h2>
      <dl>
        <dt>Customer ID</dt><dd class="mono">${d.customer_no || 'no account'}</dd>
        <dt>Winning ticket</dt><dd class="mono">${d.ticket}</dd>
        <dt>Their entries</dt><dd>${d.winner_entries} of ${d.total_entries} (${percent(d.winner_entries / d.total_entries)} chance)</dd>
        <dt>Email</dt><dd>${d.email}</dd>
        <dt>Phone</dt><dd>${d.phone}</dd>
        <dt>${d.order_id ? 'Order' : 'Spin'}</dt><dd>#${d.order_id || d.spin_id}</dd>
        <dt>Drawn</dt><dd>${formatDate(d.drawn_at)}</dd>
      </dl>
      <div class="contact">
        <a href="mailto:${d.email}">Email</a>
        <a href="tel:${d.phone}">Call</a>
        <a href="${whatsappLink(d.phone)}" target="_blank" rel="noopener">WhatsApp</a>
      </div>
    </div>`;
  }

  function historyCard(history) {
    if (history.length < 2) return '';
    return html`<div class="card"><h2>Draw history</h2>
      <p class="hint">A redraw happens when a winner can't be reached or is disqualified. The newest draw is the winner.</p>
      <div class="table-wrap"><table>
        <thead><tr><th>Drawn</th><th>Ticket</th><th>Customer ID</th><th>Name</th><th>Email</th><th>Phone</th></tr></thead>
        <tbody>${history.map((d) => html`<tr><td>${formatDate(d.drawn_at)}</td><td class="mono">${d.ticket}</td>
          <td class="mono">${d.customer_no || '–'}</td><td>${d.first_name} ${d.last_name}</td><td>${d.email}</td><td>${d.phone}</td></tr>`)}</tbody>
      </table></div></div>`;
  }

  async function renderDraw(c) {
    const area = document.getElementById('draw-area');
    const [people, history] = await Promise.all([
      api(`/api/admin/competitions/${c.id}/participants`),
      api(`/api/admin/competitions/${c.id}/draws`),
    ]);
    const latest = history[0];
    const total = people.reduce((sum, p) => sum + p.entries, 0);

    setHTML(area, html`
      <div class="draw-layout">
        <div class="draw-stage">
          <p class="hint">${entries(total)} from ${people.length} ${people.length === 1 ? 'person' : 'people'} · <span id="draw-phase">${PHASES[c.phase]}</span></p>
          ${people.length ? html`<div id="draw-wheel"></div>` : html`<p style="margin:40px 0">There are no paid entries for this prize yet.</p>`}
          <div id="winner">${latest ? winnerCard(latest) : ''}</div>
          ${people.length
            ? html`<button class="btn primary big" id="draw-btn">${latest ? 'Redraw' : 'Spin to draw the winner'}</button>`
            : ''}
          ${c.phase === 'live' || c.phase === 'scheduled'
            ? html`<p class="hint" id="sales-open">Ticket sales are still open. Drawing now closes them for this prize.</p>`
            : ''}
        </div>
        <div class="card">
          <h2>Participants</h2>
          <p class="hint">More entries means a bigger slice of the wheel and a bigger chance to win.</p>
          ${people.length
            ? html`<div class="table-wrap"><table>
                <thead><tr><th>Customer</th><th>Entries</th><th>Chance</th></tr></thead>
                <tbody id="people">${people.map(
                  (p) => html`<tr data-key="${p.key}" class="${latest && latest.participant_key === p.key ? 'is-winner' : ''}">
                    <td><b>${p.name}</b><br><span class="hint">${p.customer_no || 'no account'} · ${p.phone}</span></td>
                    <td>${p.entries}</td>
                    <td>${percent(p.chance)}<div class="chance-bar"><i style="width:${Math.max(1, p.chance * 100)}%"></i></div></td>
                  </tr>`
                )}</tbody></table></div>`
            : html`<p class="hint">Nobody yet.</p>`}
        </div>
      </div>
      <div id="history">${historyCard(history)}</div>`);

    if (!people.length) return;
    const wheel = new DrawWheel(document.getElementById('draw-wheel'), people);
    if (latest) wheel.spinTo(latest.participant_key, { duration: 0, turns: 0 });

    const button = document.getElementById('draw-btn');
    button.onclick = async () => {
      const question = latest || c.phase === 'drawn'
        ? 'Draw a NEW winner? Only do this if the previous winner could not be reached or was disqualified. Every draw is kept in the history.'
        : `Spin the wheel and draw the winner for "${c.title}" now? Ticket sales for this prize will close.`;
      if (!confirm(question)) return;
      button.disabled = true;
      let result;
      try {
        result = await api(`/api/admin/competitions/${c.id}/draw`, { method: 'POST' });
      } catch (err) {
        toast(err.message, true);
        button.disabled = false;
        return;
      }
      setHTML(document.getElementById('winner'), '');
      area.querySelectorAll('tr.is-winner').forEach((tr) => tr.classList.remove('is-winner'));
      await wheel.spinTo(result.participant_key);

      c.phase = 'drawn';
      document.getElementById('draw-phase').textContent = PHASES.drawn;
      document.getElementById('sales-open')?.remove();
      setHTML(document.getElementById('winner'), winnerCard(result));
      area.querySelector(`tr[data-key="${CSS.escape(result.participant_key)}"]`)?.classList.add('is-winner');
      button.textContent = 'Redraw';
      button.disabled = false;
      WB.confetti();
      setHTML(document.getElementById('history'), historyCard(await api(`/api/admin/competitions/${c.id}/draws`)));
    };
  }

  // ------------------------------------------------------------------ website

  async function website() {
    const site = await api('/api/admin/site');
    setHTML(view, html`
      <div class="page-head"><div><h1>Website</h1><p>The About section, your contact details and the live counter on the home page.</p></div></div>
      <form id="site-form">
        <div class="card">
          <h2>About us</h2>
          <p class="hint">Tell visitors who you are, what you do and why. Start a new paragraph with an empty line.</p>
          <label>Who we are<textarea name="who" rows="4" maxlength="2000">${site.about.who}</textarea></label>
          <label>What we do<textarea name="what" rows="4" maxlength="2000">${site.about.what}</textarea></label>
          <label>Why we do it<textarea name="why" rows="4" maxlength="2000">${site.about.why}</textarea></label>
        </div>
        <div class="card">
          <h2>Contact details</h2>
          <p class="hint">Shown at the bottom of every page. Leave a box empty to hide it.</p>
          <div class="row">
            <label>Email<input name="email" type="email" value="${site.contact.email}" placeholder="hello@winbigza.co.za"></label>
            <label>Phone<input name="phone" type="tel" value="${site.contact.phone}" placeholder="082 123 4567"></label>
          </div>
          <label>WhatsApp number<input name="whatsapp" type="tel" value="${site.contact.whatsapp}" placeholder="082 123 4567"></label>
        </div>
        <div class="card">
          <h2>Live counter</h2>
          <label class="check-row"><input type="checkbox" name="show_counter" ${site.show_counter ? 'checked' : ''}>
            <span>Show "<b>X people have registered</b>" on the home page (updates live)</span></label>
        </div>
        <p class="form-error" id="site-error"></p>
        <div class="form-actions" style="justify-content:flex-start"><button class="btn primary">Save website</button>
          <a class="btn" href="/#about" target="_blank">View on website ↗</a></div>
      </form>`);

    const form = document.getElementById('site-form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const el = form.elements;
      document.getElementById('site-error').textContent = '';
      try {
        await api('/api/admin/site', {
          method: 'PUT',
          body: {
            about: { who: el.who.value, what: el.what.value, why: el.why.value },
            contact: { email: el.email.value, phone: el.phone.value, whatsapp: el.whatsapp.value },
            show_counter: el.show_counter.checked,
          },
        });
        toast('Website saved');
      } catch (err) {
        document.getElementById('site-error').textContent = err.message;
      }
    };
  }

  // ------------------------------------------------------------------ payments (Yoco)

  async function payments() {
    const p = await api('/api/admin/payments');
    const modeText = {
      demo: 'Not connected yet. The website is in demo mode: payments are pretend and no money is taken.',
      test: 'Connected in TEST mode: use Yoco test cards, no real money moves.',
      live: 'Connected in LIVE mode: real payments are being taken.',
    };
    const online = p.publicUrl.startsWith('https://');
    const modeMismatch = p.webhookMode && p.mode !== 'demo' && p.webhookMode !== p.mode;

    setHTML(view, html`
      <div class="page-head"><div><h1>Payments (Yoco)</h1>
        <p>Connect your Yoco account here so customers can pay by card or instant EFT.</p></div></div>

      <div class="card">
        <h2>Yoco account</h2>
        <p>${pill(p.mode)} ${modeText[p.mode]}</p>
        <form id="yoco-form">
          <label>Yoco secret key
            ${p.keyHint ? html`<span class="hint">(saved: <span class="mono">${p.keyHint}</span>${p.keySource === 'env' ? ', from the .env file' : ''})</span>` : ''}
            <input name="secretKey" type="password" autocomplete="off" spellcheck="false"
              placeholder="${p.keyHint ? 'Paste a new key to replace the saved one' : 'sk_test_… or sk_live_…'}">
            <span class="hint">In the Yoco Business Portal go to <b>Sell Online → Payment Gateway</b> (in the Yoco app: <b>Sales → Payment Gateway</b>)
              and copy the <b>secret key</b>. Start with the test key (<span class="mono">sk_test_…</span>).</span>
          </label>
          <label>Website address
            <input name="publicUrl" type="url" value="${p.publicUrl}" placeholder="https://winbig.co.za">
            <span class="hint">The address people type to visit WinBig. Once the site is online this must start with <b>https://</b>.</span>
          </label>
          <p class="form-error" id="yoco-error"></p>
          <div class="form-actions" style="justify-content:flex-start">
            <button class="btn primary" id="yoco-save">Save &amp; connect</button>
            ${p.keySource === 'admin' ? html`<button type="button" class="btn danger" id="yoco-remove">Remove key</button>` : ''}
          </div>
        </form>
      </div>

      ${p.mode !== 'demo' && !online
        ? html`<div class="alert">Your key is saved, but the website address isn't an <b>https://</b> address yet. Yoco can only confirm payments
            to a website that's online, so tickets won't be issued until you put the site online and save its https:// address here.
            To try everything on this computer, remove the key to go back to demo mode.</div>`
        : ''}

      <div class="card">
        <h2>Payment notifications</h2>
        <p class="hint">When someone pays, Yoco notifies WinBig, and that is what issues their tickets. This is set up automatically
          when you click "Save &amp; connect" on a website with an https:// address.</p>
        <table class="kv">
          <tr><th>Status</th><td>${p.mode === 'demo'
            ? html`<span class="hint">Not needed in demo mode</span>`
            : p.webhookConfigured
              ? html`${pill('ok', 'Connected')} ${p.webhookRegisteredAt ? `since ${formatDate(p.webhookRegisteredAt)}` : '(set in .env)'}`
              : pill('bad', 'Not connected: tickets will not be issued!')}</td></tr>
          <tr><th>Notification address</th><td><code>${p.webhookUrl}</code></td></tr>
        </table>
        ${modeMismatch
          ? html`<div class="alert error" style="margin-top:14px">Notifications were set up in ${p.webhookMode} mode but your key is now a ${p.mode} key. Click "Reconnect".</div>`
          : ''}
        ${p.mode !== 'demo' && online
          ? html`<div class="form-actions" style="justify-content:flex-start"><button class="btn" id="reconnect">Reconnect</button></div>`
          : ''}
      </div>`);

    const $ = (id) => document.getElementById(id);
    $('yoco-form').onsubmit = async (e) => {
      e.preventDefault();
      const form = e.target;
      $('yoco-error').textContent = '';
      $('yoco-save').disabled = true;
      try {
        const r = await api('/api/admin/payments/settings', {
          method: 'PUT',
          body: { secretKey: form.elements.secretKey.value, publicUrl: form.elements.publicUrl.value },
        });
        toast(
          r.mode === 'demo'
            ? 'Saved. Add your Yoco secret key to start taking payments.'
            : r.webhook === 'connected'
              ? `Saved. Yoco is connected (${r.mode} mode) and payment notifications are on.`
              : `Key saved (${r.mode} mode). Payment notifications connect once the website address starts with https://.`
        );
        payments();
      } catch (err) {
        $('yoco-error').textContent = err.message;
        $('yoco-save').disabled = false;
      }
    };
    if ($('yoco-remove')) {
      $('yoco-remove').onclick = async () => {
        if (!confirm('Remove the Yoco key? The website goes back to demo mode and stops taking real payments.')) return;
        await api('/api/admin/payments/key', { method: 'DELETE' }).catch((err) => toast(err.message, true));
        toast('Yoco key removed');
        payments();
      };
    }
    if ($('reconnect')) {
      $('reconnect').onclick = async (e) => {
        e.target.disabled = true;
        try {
          await api('/api/admin/payments/register-webhook', { method: 'POST' });
          toast('Payment notifications reconnected');
          payments();
        } catch (err) {
          toast(err.message, true);
          e.target.disabled = false;
        }
      };
    }
  }

  // ------------------------------------------------------------------ admin password

  function changePassword() {
    setHTML(modal, html`<form>
      <h2>Change admin password</h2>
      <label>Current password<input type="password" name="current" autocomplete="current-password" required></label>
      <label>New password <span class="hint">(at least 8 characters)</span><input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
      <label>Type the new password again<input type="password" name="confirm" autocomplete="new-password" required></label>
      <p class="form-error" id="form-error"></p>
      <div class="form-actions"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary">Change password</button></div>
    </form>`);
    const form = modal.querySelector('form');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const { current, password, confirm: again } = form.elements;
      if (password.value !== again.value) {
        modal.querySelector('#form-error').textContent = "The new passwords don't match.";
        return;
      }
      try {
        await api('/api/admin/password', { method: 'PUT', body: { current: current.value, password: password.value } });
        modal.close();
        toast('Admin password changed');
      } catch (err) {
        modal.querySelector('#form-error').textContent = err.message;
      }
    };
    modal.showModal();
  }

  // ------------------------------------------------------------------ routing

  const pages = { dashboard, prizes, packages, wheel, customers, orders, draw, website, payments };

  async function route() {
    const name = pages[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard';
    document.querySelectorAll('#tabs a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === `#${name}`));
    if (modal.open) modal.close();
    setHTML(view, html`<p class="hint">Loading…</p>`);
    try {
      await pages[name]();
    } catch (err) {
      setHTML(view, html`<div class="alert error">${err.message}</div>`);
    }
  }

  document.getElementById('change-password').onclick = changePassword;
  document.getElementById('logout').onclick = async () => {
    await WB.api('/api/admin/logout', { method: 'POST' }).catch(() => {});
    location.href = '/admin/login';
  };

  window.addEventListener('hashchange', route);
  api('/api/admin/me').then(route, () => {});
})();
