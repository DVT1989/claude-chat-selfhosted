/**
 * Init script of Browser (NAS) (runs in every frame, before the page): catches a submitted login form and
 * reports it through the binding __ccPwEvent (exposeBinding), finds login fields for autofill, and fills them.
 * The password goes from the page to the server only on submit, and from the server to the page only when filling.
 */
export const PW_BINDING = '__ccPwEvent';

export const PW_SCRIPT = `(() => {
  if (window.__ccPwReady) return;
  try { Object.defineProperty(window, '__ccPwReady', { value: true }); } catch (e) { return; }
  const send = (ev) => { try { const f = window.${PW_BINDING}; if (typeof f === 'function') f(ev); } catch (e) {} };
  const SKEY = '__ccpwu:' + location.origin;
  const memGet = () => { try { const v = JSON.parse(sessionStorage.getItem(SKEY) || 'null'); return v && Date.now() - v.at < 600000 ? v.u : ''; } catch (e) { return ''; } };
  const memSet = (u) => { try { sessionStorage.setItem(SKEY, JSON.stringify({ u, at: Date.now() })); } catch (e) {} };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const inputs = (root) => Array.from((root || document).querySelectorAll('input')).filter(visible);
  const passInputs = (root) => inputs(root).filter((e) => e.type === 'password');
  const TEXTY = /^(text|email|tel|url|)$/i;
  const AUTHNAME = /user|login|email|e-mail|ident|account|gebruiker|inlog|mail/i;
  const isUserField = (e) => TEXTY.test(e.type) && !e.readOnly && !/search|zoek|query/i.test((e.name || '') + (e.id || '') + (e.getAttribute('role') || ''))
    && (e.type === 'email' || /username|email/i.test(e.autocomplete || '') || AUTHNAME.test((e.name || '') + ' ' + (e.id || '') + ' ' + (e.getAttribute('aria-label') || '')));
  const userFor = (pw) => {
    const scope = pw.form || document;
    const c = inputs(scope).filter((e) => TEXTY.test(e.type) && !e.readOnly && (pw.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_PRECEDING));
    return c.length ? c[c.length - 1] : null;
  };
  const setVal = (el, v) => {
    const d = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value');
    el.focus && el.focus();
    if (d && d.set) d.set.call(el, v); else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const BADBTN = /show|toon|zien|toggle|visib|eye|reveal|hide|verberg|forgot|vergeten|help|create|maak|aanmaken|register|registr|privacy|cancel|annul|back|terug/i;

  let lastSent = '', lastAt = 0;
  const check = () => {
    const pws = passInputs().filter((e) => e.value);
    if (pws.length) {
      const pw = pws[0];
      const u = userFor(pw);
      const username = ((u && u.value) || memGet() || '').trim();
      if (!username) return;
      const sig = username + '\\u0000' + pw.value;
      if (sig === lastSent && Date.now() - lastAt < 3000) return;
      lastSent = sig; lastAt = Date.now();
      send({ type: 'login', username, password: pw.value });
      return;
    }
    // first step (only a user name, e.g. Google): remember it for the password step
    const u = inputs().find((e) => e.value && isUserField(e));
    if (u) memSet(u.value.trim());
  };

  document.addEventListener('submit', () => check(), true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') check();
  }, true);
  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('button,input[type=submit],input[type=button],[role=button],a') : null;
    if (!t) return;
    const label = ((t.getAttribute('aria-label') || '') + ' ' + (t.innerText || t.value || '') + ' ' + (t.title || '') + ' ' + (t.className && t.className.baseVal === undefined ? t.className : '')).slice(0, 200);
    if (t.tagName === 'A' && !t.getAttribute('role')) return;
    if (BADBTN.test(label) && t.type !== 'submit') return;
    check();
  }, true);

  // ── login fields found: tell the server once per change (autofill) ──
  let lastSig = '', timer = 0;
  const scan = () => {
    timer = 0;
    try {
      const pw = passInputs().find((e) => !/new-password/i.test(e.autocomplete || ''));
      const user = inputs().find((e) => isUserField(e));
      if (!pw && !user) return;
      const pwEmpty = !!pw && !pw.value, userEmpty = !!user && !user.value;
      if (!pwEmpty && !userEmpty) return;
      // a lone user field is only a login step when it looks like one (email/username), a password field always is
      const sig = (pw ? 'p' : '-') + (user ? 'u' : '-') + (pwEmpty ? 1 : 0) + (userEmpty ? 1 : 0);
      if (sig === lastSig) return;
      lastSig = sig;
      send({ type: 'fields', pass: pwEmpty, user: userEmpty, known: memGet() });
    } catch (e) {}
  };
  const later = () => { if (!timer) timer = setTimeout(scan, 500); };
  const start = () => {
    later();
    try { new MutationObserver(later).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] }); } catch (e) {}
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.addEventListener('load', later);
  window.addEventListener('pageshow', later);

  const fill = (username, password) => {
    const out = { user: false, pass: false };
    const pw = passInputs().find((e) => !e.value && !/new-password/i.test(e.autocomplete || ''));
    let user = null;
    if (username) {
      user = inputs().find((e) => !e.value && isUserField(e)) || (pw && userFor(pw) && !userFor(pw).value ? userFor(pw) : null);
      if (user && !user.value) { setVal(user, username); out.user = true; }
    }
    if (pw && password) { setVal(pw, password); out.pass = true; }
    return out;
  };
  const info = () => ({
    password: passInputs().some((e) => !/new-password/i.test(e.autocomplete || '')),
    username: inputs().some((e) => isUserField(e)),
  });
  try {
    Object.defineProperty(window, '__ccPwFill', { value: fill });
    Object.defineProperty(window, '__ccPwInfo', { value: info });
  } catch (e) {}
})();`;
