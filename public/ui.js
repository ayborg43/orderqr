/* Shared helpers: icons, formatting, escaping, toasts, status steps. Classic script -> window.UI */
(function () {
  const P = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    bag: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    flame: '<path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>',
    leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    receipt: '<path d="M4 2v20l3-2 2.5 2L12 20l2.5 2L17 20l3 2V2l-3 2-2.5-2L12 4 9.5 2 7 4z"/><path d="M8 9h8M8 13h8"/>',
    printer: '<path d="M6 9V2h12v7"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v8H6z"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
    note: '<path d="M4 4h16v12l-5 5H4z"/><path d="M15 21v-5h5"/>',
    home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/>',
    gf: '<path d="M12 21V8"/><path d="M12 8c-2-.5-3.5-2-3.5-4 2 .3 3.500 1.800 3.500 4Zm0 0c2-.5 3.500-2 3.500-4-2 .3-3.500 1.800-3.500 4Zm0 5c-2-.5-3.500-2-3.500-4 2 .3 3.500 1.800 3.500 4Zm0 0c2-.5 3.500-2 3.500-4-2 .3-3.500 1.800-3.500 4Z"/>',
    qr: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 14h3v3h-3zM21 14v.01M14 21v.01M18 18h3v3h-3z"/>',
    phone: '<rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18.5h2"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h10"/>',
    sliders: '<path d="M5 7h9M18 7h1M5 12h3M12 12h7M5 17h11M20 17h-1"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="17" r="2"/>',
  };
  const icon = (n, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`;
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = (n) => '₦' + Number(n).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const glaze = (cat) => 'glaze glaze-' + (({ Mains: 'mains', Starters: 'starters', Sides: 'sides', Drinks: 'drinks', Desserts: 'desserts' })[cat] || 'default');
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const DIET = { vegan: ['leaf', 'Vegan'], vegetarian: ['leaf', 'Vegetarian'], 'gluten-free': ['gf', 'Gluten-free'], spicy: ['flame', 'Spicy'] };
  const dietTag = (d) => { const [i, label] = DIET[d] || ['leaf', d]; return `<span class="tag ${esc(d)}">${icon(i)}${esc(label)}</span>`; };
  const STEPS = ['Received', 'Preparing', 'Ready', 'Served'];

  // Toast: kind = ok | err. Errors stay until dismissed; ok auto-clears.
  let tid;
  function toast(html, kind = 'ok') {
    const box = $('#alert'); if (!box) return;
    clearTimeout(tid);
    if (!html) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="notice ${kind}" role="${kind === 'err' ? 'alert' : 'status'}">${icon(kind === 'ok' ? 'checkCircle' : 'alert')}<div>${html}</div><button type="button" aria-label="Dismiss">${icon('x')}</button></div>`;
    $('button', box).onclick = () => { box.innerHTML = ''; };
    if (kind === 'ok') tid = setTimeout(() => { box.innerHTML = ''; }, 9000);
  }
  async function api(url, opts) {
    const r = await fetch(url, opts);
    let data = {}; try { data = await r.json(); } catch {}
    return { ok: r.ok, status: r.status, data };
  }
  const send = (url, method, body) => api(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });

  /* --- Staff sign-in gate (kitchen/admin pages) --- */
  async function authMe() { const r = await api('/api/auth/me'); return r.ok ? r.data : null; }
  function wireSignOut() {
    const b = $('#signOut'); if (!b) return;
    b.hidden = false;
    b.onclick = async () => { await send('/api/auth/logout', 'POST'); location.reload(); };
  }
  // Shows a sign-in overlay until a staff session exists (and, if `roles` is
  // given, has one of those roles). Resolves with { user, role } or null when
  // the signed-in role is not allowed here (overlay stays up with a message).
  function ensureStaff({ roles } = {}) {
    return new Promise(async (resolve) => {
      const me = await authMe();
      if (me && (!roles || roles.includes(me.role))) return resolve(me);
      let gate = $('#authGate');
      if (!gate) {
        gate = document.createElement('div');
        gate.id = 'authGate'; gate.className = 'auth-gate';
        document.body.appendChild(gate);
      }
      const wrongRole = me && roles && !roles.includes(me.role);
      gate.innerHTML = `<form class="auth-card" id="authForm">
        <span class="auth-card__brand">${esc(document.title.split('—')[0].trim() || 'Staff')}</span>
        <h2>Staff sign in</h2>
        ${wrongRole ? `<p class="auth-card__msg">You are signed in as <b>${esc(me.user)}</b> (${esc(me.role)}). This screen needs a ${esc(roles.join(' or '))} account.</p>` : '<p class="auth-card__msg">Kitchen and admin screens are for staff only. Guests order from the table QR code.</p>'}
        ${wrongRole ? '<button class="btn block" type="button" id="authSwitch">Sign in as someone else</button>' : `<label class="field"><span>Username</span><input type="text" id="authUser" autocomplete="username" required></label>
        <label class="field"><span>Password</span><input type="password" id="authPass" autocomplete="current-password" required></label>
        <p class="auth-card__err" id="authErr" role="alert"></p>
        <button class="btn block lg" type="submit">Sign in</button>
        <p class="auth-card__hint">Demo accounts — manager: <b>admin / admin123</b> · kitchen: <b>kitchen / kitchen123</b><br>Change them with MANAGER_PASSWORD / KITCHEN_PASSWORD.</p>`}
        <a class="auth-card__home" href="/">← Back to home</a></form>`;
      if (wrongRole) {
        $('#authSwitch', gate).onclick = async () => { await send('/api/auth/logout', 'POST'); location.reload(); };
        return resolve(null);
      }
      $('#authForm', gate).onsubmit = async (e) => {
        e.preventDefault();
        const { ok, data } = await send('/api/auth/login', 'POST', { username: $('#authUser', gate).value.trim(), password: $('#authPass', gate).value });
        if (ok) location.reload();
        else $('#authErr', gate).textContent = data.error || 'Sign-in failed. Try again.';
      };
      $('#authUser', gate).focus();
    });
  }

  window.UI = { icon, esc, fmt, $, $$, glaze, slug, dietTag, STEPS, toast, api, send, authMe, ensureStaff, wireSignOut };
})();
