(async function () {
  const { html, setHTML } = WB;
  const $ = (id) => document.getElementById(id);

  const user = await WB.initAuthNav();
  if (!user) {
    location.replace('/signin?next=/spin');
    return;
  }
  let state;
  try {
    state = await WB.api('/api/account/spin');
  } catch (err) {
    document.body.insertAdjacentText('beforeend', err.message);
    return;
  }
  $('spin-page').hidden = false;

  const comp = state.competition;
  const values = state.wheel.length ? state.wheel : [1];
  const maxWin = Math.max(...values);
  const wheel = new PrizeWheel($('wheel'), values);
  const entries = (n) => `${n} ${n === 1 ? 'entry' : 'entries'}`;
  const spins = (n) => `${n} ${n === 1 ? 'spin' : 'spins'}`;

  let myEntries = comp ? comp.my_entries : 0;
  let busy = false;
  let autoRunning = false;
  let stopRequested = false;
  let spinCount = 0;
  let sessionEntries = 0;

  setHTML(
    $('spin-head'),
    comp
      ? html`<img src="${comp.image_url || '/img/prize-placeholder.svg'}" alt="">
             <div><p class="eyebrow">Spinning for</p><h1>${comp.title}</h1>
               <p>Winner drawn ${WB.formatDate(comp.draw_at, { dateStyle: 'full', timeStyle: 'short' })}</p></div>`
      : html`<div><p class="eyebrow">Spin the wheel</p><h1>No prize is open right now</h1></div>`
  );

  function update() {
    $('sp-credits').textContent = state.credits;
    $('sp-entries').textContent = myEntries;
    const open = comp && comp.phase === 'open';
    const canSpin = open && state.credits > 0;

    $('spin-one').disabled = busy || !canSpin;
    $('spin-all').disabled = !canSpin && !autoRunning;
    $('spin-all').textContent = autoRunning ? 'Stop' : `Spin all (${state.credits})`;
    $('spin-all').hidden = state.credits < 2 && !autoRunning;

    let notice = '';
    if (!comp || comp.phase === 'ended') notice = `There is no prize open right now. Your ${spins(state.credits)} are saved for the next prize.`;
    else if (comp.phase === 'upcoming') {
      notice = `Spinning opens ${WB.formatDate(comp.starts_at, { dateStyle: 'full', timeStyle: 'short' })}. Your ${spins(state.credits)} are saved.`;
    } else if (state.credits === 0) notice = 'You have no spins left. Buy more spins or credits to keep playing.';
    $('spin-notice').hidden = !notice;
    $('spin-notice').textContent = notice;
  }

  $('sp-results').reversed = true; // newest spin first, numbered from the top down

  function addResult(result) {
    spinCount += 1;
    sessionEntries += result.entries;
    $('sp-empty').hidden = true;
    const t = result.tickets;
    const range = t.length > 1 ? `${t[0]} – ${t[t.length - 1]}` : t[0];
    const li = document.createElement('li');
    setHTML(li, html`<b>+${entries(result.entries)}</b><span>${range}</span>`);
    $('sp-results').prepend(li);
  }

  async function spinOnce(fast) {
    const result = await WB.api('/api/account/spin', { method: 'POST' });
    state.credits = result.credits;
    await wheel.spinTo(result.entries, fast ? { duration: 1700, turns: 3 } : {});
    myEntries = result.my_entries;
    addResult(result);
    return result;
  }

  $('spin-one').onclick = async () => {
    busy = true;
    $('spin-error').textContent = '';
    $('spin-summary').hidden = true;
    update();
    try {
      const result = await spinOnce(false);
      if (result.entries === maxWin) WB.confetti();
    } catch (err) {
      $('spin-error').textContent = err.message;
    }
    busy = false;
    update();
    WB.initAuthNav(); // refresh the spins count in the header
  };

  $('spin-all').onclick = async () => {
    if (autoRunning) {
      stopRequested = true;
      return;
    }
    autoRunning = true;
    busy = true;
    stopRequested = false;
    $('spin-error').textContent = '';
    $('spin-summary').hidden = true;
    const before = { count: spinCount, entries: sessionEntries };
    update();
    try {
      while (state.credits > 0 && !stopRequested) {
        await spinOnce(true);
        update();
      }
      const won = sessionEntries - before.entries;
      if (won > 0) {
        WB.confetti();
        $('spin-summary').hidden = false;
        $('spin-summary').textContent = `🎉 You won ${entries(won)} from ${spins(spinCount - before.count)}!`;
      }
    } catch (err) {
      $('spin-error').textContent = err.message;
    }
    autoRunning = false;
    busy = false;
    update();
    WB.initAuthNav();
  };

  update();
})();
