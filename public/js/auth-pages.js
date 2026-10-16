/* Sign in and sign up pages. */
(function () {
  const $ = (id) => document.getElementById(id);
  const form = document.querySelector('form[data-auth]');
  const mode = form.dataset.auth; // signin | signup

  // Only follow ?next= links that stay on this website.
  const next = new URLSearchParams(location.search).get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : null;
  const destination = safeNext || (mode === 'signup' ? '/#tickets' : '/account');

  document.querySelectorAll('[data-keep-next]').forEach((link) => {
    if (safeNext) link.href += `?next=${encodeURIComponent(safeNext)}`;
  });

  // Already signed in? Carry on.
  WB.api('/api/account/me')
    .then(({ user }) => user && location.replace(destination))
    .catch(() => {});

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const button = form.querySelector('button[type=submit]');
    $('form-error').textContent = '';
    button.disabled = true;
    const body =
      mode === 'signup'
        ? {
            first_name: $('f-first').value,
            last_name: $('f-last').value,
            email: $('f-email').value,
            phone: $('f-phone').value,
            password: $('f-password').value,
            agree: $('f-agree').checked,
          }
        : { email: $('f-email').value, password: $('f-password').value };
    try {
      await WB.api(`/api/account/${mode}`, { method: 'POST', body });
      location.href = destination;
    } catch (err) {
      $('form-error').textContent = err.message;
      button.disabled = false;
    }
  });
})();
