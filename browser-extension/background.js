// Claude Chat Browser: koppelt deze browser als apparaat (type 'browser') aan Claude Chat.
// Zelfde protocol als de Claude Agent: long-poll op /devices/agent/poll, antwoorden op /devices/agent/result.
// Veiligheid: alleen na koppeling, alleen http(s)-pagina's (nooit chrome://, extensies, file:// enz.),
// badge "AI" + de gele Chrome-balk "debugt deze browser" zolang Claude een tabblad bedient, pauzeerknop in het popup.

importScripts('overlay.js');

const VERSION = chrome.runtime.getManifest().version;
const MAX_SHOT_W = 1280;
const IDLE_DETACH_MS = 15000;
const UI_IDLE_MS = 5000;      // cursor en rand verdwijnen na zoveel stilte (einde van de beurt)
const PERM_KEEP_MS = 90000;   // toestemming voor een tabblad waar de gebruiker kijkt blijft zo lang staan
const NEE_MS = 60000;         // na Niet nu of Stop niet opnieuw vragen

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get: () => chrome.storage.local.get(['apiBase', 'server', 'token', 'deviceId', 'name', 'paused']),
  set: (o) => chrome.storage.local.set(o),
};

// ── Veiligheid: welke pagina's mag Claude bedienen ───────────
function allowedUrl(u) {
  try {
    const x = new URL(u);
    if (x.protocol !== 'http:' && x.protocol !== 'https:') return false;
    if (x.hostname === 'chromewebstore.google.com') return false;
    if (x.hostname === 'chrome.google.com' && x.pathname.startsWith('/webstore')) return false;
    return true;
  } catch { return false; }
}
const tabUrl = (t) => t.pendingUrl || t.url || '';
const tabOk = (t) => allowedUrl(tabUrl(t));
class UserError extends Error {}
const fail = (m) => { throw new UserError(m); };

// ── Status: badge en titel ───────────────────────────────────
let online = false;
async function paintStatus() {
  const s = await store.get();
  const acting = attached.size > 0;
  let title = 'Claude Chat Browser: niet gekoppeld';
  if (s.token) title = s.paused ? 'Claude Chat Browser: gepauzeerd (Claude mag niets bedienen)' : online ? 'Claude Chat Browser: gekoppeld' : 'Claude Chat Browser: geen verbinding met de server';
  if (acting) title = 'Claude bedient nu een tabblad in deze browser';
  await chrome.action.setTitle({ title });
  if (acting) { await chrome.action.setBadgeBackgroundColor({ color: '#d97706' }); await chrome.action.setBadgeText({ text: 'AI' }); }
  else if (s.token && s.paused) { await chrome.action.setBadgeBackgroundColor({ color: '#6b7280' }); await chrome.action.setBadgeText({ text: '||' }); }
  else if (s.token && !online) { await chrome.action.setBadgeBackgroundColor({ color: '#b91c1c' }); await chrome.action.setBadgeText({ text: '!' }); }
  else await chrome.action.setBadgeText({ text: '' });
  void pushPanel();
}

// ── Debugger-sessies (kort, per tabblad) ─────────────────────
const attached = new Map(); // tabId -> { timer }
const lastShot = new Map(); // tabId -> { scale }
const send = (tabId, method, params) => chrome.debugger.sendCommand({ tabId }, method, params ?? {});

async function attach(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) fail(`Tabblad ${tabId} bestaat niet (meer)`);
  if (!tabOk(tab)) fail('Dit tabblad is een interne of beschermde pagina (bijvoorbeeld chrome://) en wordt niet bediend');
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3').catch((e) => fail(`Kan tabblad niet bedienen: ${e.message}`));
    attached.set(tabId, { timer: null, uiTimer: null });
    await send(tabId, 'Page.enable').catch(() => {});
    await send(tabId, 'Runtime.enable').catch(() => {});
    await send(tabId, 'Runtime.addBinding', { name: 'claudeChoice' }).catch(() => {});
    void paintStatus();
  }
  touch(tabId);
  return tab;
}
function touch(tabId) {
  const a = attached.get(tabId);
  if (!a) return;
  clearTimeout(a.timer);
  a.timer = setTimeout(() => detach(tabId), IDLE_DETACH_MS);
  clearTimeout(a.uiTimer);
  a.uiTimer = setTimeout(() => { void uiEnd(tabId); }, UI_IDLE_MS);
}
async function detach(tabId) {
  const a = attached.get(tabId);
  if (!a) return;
  clearTimeout(a.timer); clearTimeout(a.uiTimer);
  await uiEnd(tabId);
  attached.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => {});
  void paintStatus();
}
async function detachAll() { for (const id of [...attached.keys()]) await detach(id); }
chrome.debugger.onDetach.addListener((src) => {
  if (src.tabId !== undefined && attached.has(src.tabId)) { clearTimeout(attached.get(src.tabId).timer); attached.delete(src.tabId); void paintStatus(); }
});
// Navigeert een bediend tabblad naar een niet-toegestane pagina: meteen loslaten.
chrome.tabs.onUpdated.addListener((id, info, tab) => { if (attached.has(id) && (info.url || info.status) && !tabOk(tab)) void detach(id); });
chrome.tabs.onRemoved.addListener((id) => { attached.delete(id); lastShot.delete(id); ses.delete(id); });


// ── Zichtbare overname: cursor, rand, toestemming, stop ──────
const ses = new Map();      // tabId -> { ok, last, neeUntil }
const asks = new Map();     // tabId -> { nonce, resolve }
const uiEval = (tabId, expr) => send(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: false, timeout: 3000 }).then((r) => r.result?.value).catch(() => undefined);
const uiCall = (tabId, call) => uiEval(tabId, `(${OVERLAY_JS}).${call}`);
async function uiEnd(tabId) { if (attached.has(tabId)) await uiCall(tabId, 'end()'); }
const NEE = () => fail('De gebruiker wil nu niet dat je in dit tabblad werkt (die is daar zelf bezig of heeft Claude gestopt). Doe het later of vraag het in de chat.');
// Stop (overlay of zijpaneel): meteen alles laten vallen. Antwoord op de toestemmingsvraag: ja of nee.
function stopTab(id) {
  const q = asks.get(id);
  const s = ses.get(id) || {};
  s.ok = false; s.neeUntil = Date.now() + NEE_MS; ses.set(id, s);
  if (q) { asks.delete(id); q.resolve(false); }
  void uiEnd(id);
  void pushPanel();
}
function answerAsk(id, nonce, ja) {
  const q = asks.get(id);
  if (q && nonce === q.nonce) { asks.delete(id); q.resolve(!!ja); void pushPanel(); }
}
chrome.debugger.onEvent.addListener((src, method, params) => {
  if (method !== 'Runtime.bindingCalled' || params.name !== 'claudeChoice' || src.tabId === undefined) return;
  let m; try { m = JSON.parse(params.payload); } catch { return; }
  if (m.t === 'stop') return stopTab(src.tabId);
  if (m.t === 'ja' || m.t === 'nee') answerAsk(src.tabId, m.n, m.t === 'ja');
});
// Is dit het tabblad waar de gebruiker nu naar kijkt?
async function viewed(tab) {
  if (!tab.active) return false;
  const w = await chrome.windows.get(tab.windowId).catch(() => null);
  return !!(w && w.focused);
}
// Aan het begin van elke handeling op een tabblad: wel/niet toegestaan, en rand + cursor tonen.
// Achtergrondtabblad: nooit wisselen. Geen toestemmingsvraag; Stop werkt wel.
async function gate(tab) {
  const id = tab.id;
  const s = ses.get(id) || {};
  const now = Date.now();
  if (s.neeUntil && s.neeUntil > now) NEE();
  if (s.ok && now - (s.last || 0) > PERM_KEEP_MS) s.ok = false;
  ses.set(id, s);
  // Geen toestemmingsvraag meer: koppelen is de toestemming. Stop in de overlay of het zijpaneel blijft werken (neeUntil).
  if (!s.ok) {
    s.ok = true;
    await uiCall(id, 'working()');
  }
  s.last = Date.now();
  await uiCall(id, 'start()');
  touch(id);
}
// Cursor naar een punt (CSS-pixels van de viewport) laten glijden en wachten tot hij er is.
async function glide(tabId, x, y) {
  guard(tabId);
  const ms = Number(await uiCall(tabId, `move(${Math.round(x)},${Math.round(y)})`)) || 0;
  if (ms) await sleep(Math.min(ms, 700) + 30);
}
const uiClick = (tabId) => uiCall(tabId, 'click()');
// Na elke stap: is er in de pagina op Stop gedrukt?
function guard(tabId) { const s = ses.get(tabId); if (s && s.neeUntil && s.neeUntil > Date.now()) NEE(); }

async function resolveTab(args) {
  if (args.tab !== undefined && args.tab !== null) {
    const t = await chrome.tabs.get(Number(args.tab)).catch(() => null);
    if (!t) fail(`Tabblad ${args.tab} bestaat niet`);
    return t;
  }
  const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const cands = t && tabOk(t) ? [t] : (await chrome.tabs.query({ active: true })).filter(tabOk);
  if (!cands.length) fail('Geen bedienbaar actief tabblad (interne pagina?). Gebruik tabs voor de lijst, of open een pagina met cmd "open".');
  return cands[0];
}
const info = (t) => ({ id: t.id, windowId: t.windowId, active: t.active, title: tabOk(t) ? t.title : '(niet toegankelijk)', url: tabOk(t) ? tabUrl(t) : '(niet toegankelijk)', status: t.status, controllable: tabOk(t) });

async function waitLoaded(tabId, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  await sleep(200);
  while (Date.now() < end) {
    const t = await chrome.tabs.get(tabId).catch(() => null);
    if (!t) return null;
    if (t.status === 'complete') { await sleep(250); return chrome.tabs.get(tabId); }
    await sleep(200);
  }
  return chrome.tabs.get(tabId).catch(() => null);
}
async function foreground(tab) {
  await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
  await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
}

// JPEG (base64) terugschalen naar de gevraagde breedte; werkt in de service worker (OffscreenCanvas).
async function downscale(b64, w, h) {
  const bin = atob(b64); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
  if (bmp.width <= w) { const r = { data: b64, width: bmp.width, height: bmp.height }; bmp.close(); return r; }
  const hh = Math.round((bmp.height * w) / bmp.width);
  const cv = new OffscreenCanvas(w, hh);
  const g = cv.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(bmp, 0, 0, w, hh); bmp.close();
  const buf = new Uint8Array(await (await cv.convertToBlob({ type: 'image/jpeg', quality: 0.7 })).arrayBuffer());
  let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { data: btoa(s), width: w, height: hh };
}

// ── Commando's ───────────────────────────────────────────────
const KEYS = {
  enter: [13, 'Enter', 'Enter', '\r'], return: [13, 'Enter', 'Enter', '\r'], esc: [27, 'Escape', 'Escape'], escape: [27, 'Escape', 'Escape'],
  tab: [9, 'Tab', 'Tab'], backspace: [8, 'Backspace', 'Backspace'], delete: [46, 'Delete', 'Delete'], del: [46, 'Delete', 'Delete'],
  space: [32, ' ', 'Space', ' '], up: [38, 'ArrowUp', 'ArrowUp'], down: [40, 'ArrowDown', 'ArrowDown'], left: [37, 'ArrowLeft', 'ArrowLeft'],
  right: [39, 'ArrowRight', 'ArrowRight'], home: [36, 'Home', 'Home'], end: [35, 'End', 'End'], pageup: [33, 'PageUp', 'PageUp'], pagedown: [34, 'PageDown', 'PageDown'],
};
const MODS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, win: 4, shift: 8 };
const EDIT_CMD = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' };

function keyDef(k) {
  const x = k.toLowerCase();
  if (KEYS[x]) return { vk: KEYS[x][0], key: KEYS[x][1], code: KEYS[x][2], text: KEYS[x][3] };
  if (/^f([1-9]|1[0-2])$/.test(x)) return { vk: 111 + Number(x.slice(1)), key: x.toUpperCase(), code: x.toUpperCase() };
  if (/^[a-z]$/.test(x)) return { vk: x.toUpperCase().charCodeAt(0), key: x, code: `Key${x.toUpperCase()}`, text: x };
  if (/^[0-9]$/.test(x)) return { vk: x.charCodeAt(0), key: x, code: `Digit${x}`, text: x };
  return null;
}

async function pressKey(tabId, combo) {
  const parts = combo.split('+').map((s) => s.trim()).filter(Boolean);
  let modifiers = 0;
  let main = null;
  for (const p of parts) { if (MODS[p.toLowerCase()]) modifiers |= MODS[p.toLowerCase()]; else main = p; }
  if (!main) fail(`Geen toets in "${combo}"`);
  const d = keyDef(main);
  if (!d) fail(`Onbekende toets in "${combo}"`);
  let key = d.key, text = d.text;
  if (modifiers & 8 && /^[a-z]$/.test(d.key)) { key = d.key.toUpperCase(); text = key; }
  const printable = !(modifiers & (1 | 2 | 4));
  const base = { modifiers, key, code: d.code, windowsVirtualKeyCode: d.vk, nativeVirtualKeyCode: d.vk };
  const cmd = !printable && EDIT_CMD[d.key] && modifiers & (2 | 4) ? [EDIT_CMD[d.key]] : undefined;
  await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: printable && text ? 'keyDown' : 'rawKeyDown', ...(printable && text ? { text } : {}), ...(cmd ? { commands: cmd } : {}) });
  await send(tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

const mouse = (tabId, type, x, y, extra) => send(tabId, 'Input.dispatchMouseEvent', { type, x, y, ...extra });
async function clickAt(tabId, x, y, o = {}) {
  const button = o.button === 'right' ? 'right' : o.button === 'middle' ? 'middle' : 'left';
  const buttons = button === 'left' ? 1 : button === 'right' ? 2 : 4;
  await glide(tabId, x, y);
  await mouse(tabId, 'mouseMoved', x, y);
  void uiClick(tabId);
  for (let i = 1; i <= (o.double ? 2 : 1); i++) {
    await mouse(tabId, 'mousePressed', x, y, { button, buttons, clickCount: i });
    await mouse(tabId, 'mouseReleased', x, y, { button, buttons: 0, clickCount: i });
  }
}

async function evalIn(tabId, expression) {
  const r = await send(tabId, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, timeout: 15000 });
  if (r.exceptionDetails) fail(`Pagina gaf een fout: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result?.value;
}

const READ_JS = (maxText, maxEl) => `(() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[contenteditable=""],[contenteditable="true"],[onclick]';
  const els = [...document.querySelectorAll(sel)].filter(vis).slice(0, ${maxEl});
  window.__claudeRefs = els;
  const items = els.map((el, i) => {
    const r = el.getBoundingClientRect();
    const type = el.getAttribute('type') || undefined;
    const o = { ref: i, tag: el.tagName.toLowerCase(), type, role: el.getAttribute('role') || undefined,
      text: (el.innerText || el.value || el.getAttribute('aria-label') || el.title || el.placeholder || '').trim().replace(/\\s+/g, ' ').slice(0, 80),
      x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), inView: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth };
    if (el.tagName === 'A') o.href = el.href;
    if (el.name) o.name = el.name;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && type !== 'password' && el.value) o.value = String(el.value).slice(0, 80);
    if (type === 'password') o.secret = true;
    if (el.checked) o.checked = true;
    if (el.disabled) o.disabled = true;
    return o;
  });
  return { title: document.title, url: location.href, text: (document.body ? document.body.innerText : '').slice(0, ${maxText}),
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight }, elements: items };
})()`;

const FIND_JS = (ref, selector) => `(() => {
  const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : `(window.__claudeRefs || [])[${Number(ref)}]`};
  if (!el || !el.isConnected) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;
const FOCUS_JS = (ref, selector, clear) => `(() => {
  const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : `(window.__claudeRefs || [])[${Number(ref)}]`};
  if (!el || !el.isConnected) return 'niet gevonden';
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (el.isContentEditable) { const s = getSelection(); const g = document.createRange(); g.selectNodeContents(el); if (!${clear ? 'true' : 'false'}) g.collapse(false); s.removeAllRanges(); s.addRange(g); }
  else if (el.select) { if (${clear ? 'true' : 'false'}) el.select(); else { const n = (el.value || '').length; try { el.setSelectionRange(n, n); } catch (e) {} } }
  return 'ok';
})()`;

const cmds = {
  async tabs() {
    return { tabs: (await chrome.tabs.query({})).map(info) };
  },
  async open(a) {
    if (!allowedUrl(a.url)) fail('Alleen http(s)-adressen zijn toegestaan (geen chrome://, file:// of interne pagina\'s)');
    const t = await chrome.tabs.create({ url: a.url, active: a.background !== true });
    return { tab: info((await waitLoaded(t.id)) || t) };
  },
  async navigate(a) {
    if (!allowedUrl(a.url)) fail('Alleen http(s)-adressen zijn toegestaan (geen chrome://, file:// of interne pagina\'s)');
    const t = await resolveTab(a);
    if (!tabOk(t)) fail('Dit tabblad is een interne pagina en wordt niet bediend');
    await chrome.tabs.update(t.id, { url: a.url });
    return { tab: info((await waitLoaded(t.id)) || t) };
  },
  async history(a) {
    const t = await resolveTab(a);
    if (!tabOk(t)) fail('Dit tabblad is een interne pagina en wordt niet bediend');
    if (a.dir === 'back') await chrome.tabs.goBack(t.id).catch((e) => fail(`Terug niet mogelijk: ${e.message}`));
    else if (a.dir === 'forward') await chrome.tabs.goForward(t.id).catch((e) => fail(`Vooruit niet mogelijk: ${e.message}`));
    else await chrome.tabs.reload(t.id);
    return { tab: info((await waitLoaded(t.id)) || t) };
  },
  async close(a) {
    const t = await resolveTab(a);
    if (!tabOk(t)) fail('Dit tabblad is een interne pagina en wordt niet bediend');
    await detach(t.id);
    await chrome.tabs.remove(t.id);
    return { closed: t.id };
  },
  async focus(a) {
    const t = await resolveTab(a);
    if (!tabOk(t)) fail('Dit tabblad is een interne pagina en wordt niet bediend');
    await foreground(t);
    return { tab: info(await chrome.tabs.get(t.id)) };
  },
  async read(a) {
    const t = await resolveTab(a);
    await attach(t.id);
    await gate(t);
    const max = Math.min(Math.max(Number(a.max) || 15000, 500), 60000);
    const out = await evalIn(t.id, READ_JS(max, Math.min(Number(a.maxElements) || 200, 500)));
    touch(t.id);
    return { tab: t.id, ...out };
  },
  async screenshot(a) {
    const t = await resolveTab(a);
    await attach(t.id);
    await gate(t);   // geen tabwissel: een achtergrondtabblad blijft op de achtergrond
    const m = await send(t.id, 'Page.getLayoutMetrics');
    const v = m.cssVisualViewport;
    // Op een scherm met 2x pixels geeft Chrome 2x zoveel pixels terug: altijd terugschalen naar max. 1280 breed
    const outW = Math.round(Math.min(MAX_SHOT_W, v.clientWidth));
    const scale = outW / v.clientWidth;
    const cap = send(t.id, 'Page.captureScreenshot', { format: 'jpeg', quality: 70, clip: { x: v.pageX, y: v.pageY, width: v.clientWidth, height: v.clientHeight, scale: 1 } });
    const shot = await Promise.race([cap, sleep(12000).then(() => fail('Schermafbeelding van een achtergrondtabblad lukt niet (Chrome tekent het niet). Gebruik read, of laat de gebruiker het tabblad openen.'))]);
    const out = await downscale(shot.data, outW, Math.round(v.clientHeight * scale));
    lastShot.set(t.id, { scale });
    touch(t.id);
    return { tab: t.id, width: out.width, height: out.height, dataB64: out.data };
  },
  async act(a) {
    const t = await resolveTab(a);
    await attach(t.id);
    await gate(t);
    const actions = Array.isArray(a.actions) ? a.actions : [];
    const sc = () => { const s = lastShot.get(t.id); if (!s) fail('Maak eerst een schermafbeelding (screen); de coordinaten horen bij die afbeelding'); return s.scale; };
    let done = 0;
    for (const x of actions) {
      touch(t.id); guard(t.id);
      if (x.click) { const s = sc(); await clickAt(t.id, x.click[0] / s, x.click[1] / s, x); }
      else if (x.click_ref !== undefined || x.click_selector) {
        const p = await evalIn(t.id, FIND_JS(x.click_ref, x.click_selector));
        if (!p) fail('Element niet gevonden (lees de pagina opnieuw met read)');
        await clickAt(t.id, p.x, p.y, x);
      }
      else if (x.move) { const s = sc(); await glide(t.id, x.move[0] / s, x.move[1] / s); await mouse(t.id, 'mouseMoved', x.move[0] / s, x.move[1] / s); }
      else if (x.drag) {
        const s = sc(); const [x1, y1, x2, y2] = x.drag.map((n) => n / s);
        await glide(t.id, x1, y1);
        await mouse(t.id, 'mouseMoved', x1, y1);
        await mouse(t.id, 'mousePressed', x1, y1, { button: 'left', buttons: 1, clickCount: 1 });
        const glideMs = Number(await uiCall(t.id, `move(${Math.round(x2)},${Math.round(y2)})`)) || 0;
        for (let i = 1; i <= 8; i++) { await mouse(t.id, 'mouseMoved', x1 + ((x2 - x1) * i) / 8, y1 + ((y2 - y1) * i) / 8, { buttons: 1 }); if (glideMs) await sleep(Math.min(glideMs, 700) / 8); }
        await mouse(t.id, 'mouseReleased', x2, y2, { button: 'left', buttons: 0, clickCount: 1 });
      }
      else if (x.scroll) {
        const s = sc();
        await glide(t.id, x.scroll[0] / s, x.scroll[1] / s);
        await mouse(t.id, 'mouseWheel', x.scroll[0] / s, x.scroll[1] / s, { deltaX: 0, deltaY: Math.max(-30, Math.min(30, x.scroll[2])) * 100 });
      }
      else if (x.fill) {
        const p = await evalIn(t.id, FIND_JS(x.fill.ref, x.fill.selector));
        if (p) { await glide(t.id, p.x, p.y); void uiClick(t.id); }
        const r = await evalIn(t.id, FOCUS_JS(x.fill.ref, x.fill.selector, x.fill.clear !== false));
        if (r !== 'ok') fail('Invoerveld niet gevonden (lees de pagina opnieuw met read)');
        await send(t.id, 'Input.insertText', { text: String(x.fill.text ?? '') });
      }
      else if (x.type !== undefined) await send(t.id, 'Input.insertText', { text: String(x.type) });
      else if (x.key) await pressKey(t.id, x.key);
      else if (x.wait) await sleep(Math.min(Number(x.wait), 10000));
      done++;
      await sleep(80);
    }
    await sleep(300);
    const now = await chrome.tabs.get(t.id).catch(() => null);
    return { done, tab: now ? info(now) : { id: t.id } };
  },
};

async function runJob(job) {
  const s = await store.get();
  if (job.type !== 'browser') fail('Dit is een browser: gebruik tabs, read, screen, act of browser (open, navigate, history, close, focus)');
  if (s.paused) fail('Besturing is gepauzeerd door de gebruiker (popup van de extensie)');
  const fn = cmds[job.cmd];
  if (!fn) fail(`Onbekend commando "${job.cmd}"`);
  return fn(job.args ?? {});
}

// ── Verbinding met de server ─────────────────────────────────
async function api(path, body, token, signal) {
  const s = await store.get();
  return fetch(`${s.apiBase}/devices/agent${path}`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body ?? {}),
  });
}
async function postResult(token, r) {
  for (let i = 0; i < 3; i++) {
    try { const res = await api('/result', r, token); if (res.ok) return; } catch { /* opnieuw */ }
    await sleep(500);
  }
}
async function handle(job, token) {
  const t0 = Date.now();
  try {
    const out = await runJob(job);
    const { dataB64, ...data } = out ?? {};
    await postResult(token, { id: job.id, ok: true, data, ...(dataB64 ? { dataB64 } : {}), durationMs: Date.now() - t0 });
  } catch (e) {
    await postResult(token, { id: job.id, ok: false, error: e instanceof UserError ? e.message : `Fout in de extensie: ${e.message || e}`, durationMs: Date.now() - t0 });
  }
}
let chain = Promise.resolve();
async function sendInventory(token) {
  try {
    const ua = navigator.userAgent.match(/Chrome\/([\d.]+)/);
    const plat = (navigator.userAgentData && navigator.userAgentData.platform) || '';
    const res = await api('/inventory', { inventory: { os: `Chrome ${ua ? ua[1] : ''}`.trim(), model: `Browser${plat ? ` op ${plat}` : ''}`, agentVersion: VERSION } }, token);
    return res.ok;
  } catch { return false; /* volgende keer */ }
}

let looping = false;
async function loop() {
  if (looping) return;
  looping = true;
  let fails = 0;
  try {
    // De long-poll antwoordt pas na tot ~25 s; meteen een korte aanvraag zodat de status direct 'gekoppeld' toont.
    const s0 = await store.get();
    if (s0.token && s0.apiBase && await sendInventory(s0.token) && !online) { online = true; void paintStatus(); }
    for (;;) {
      const s = await store.get();
      if (!s.token || !s.apiBase) break;
      try {
        const res = await api('/poll', { version: VERSION }, s.token);
        if (res.status === 401) { await unlink(); break; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        if (!online || fails) { online = true; void paintStatus(); }
        fails = 0;
        for (const job of j.jobs ?? []) chain = chain.then(() => handle(job, s.token));
      } catch {
        fails++;
        if (online) { online = false; void paintStatus(); }
        await sleep(Math.min(30000, 1500 * fails));
      }
    }
  } finally { looping = false; }
}

async function unlink() {
  await detachAll();
  online = false;
  await chrome.storage.local.remove(['token', 'deviceId', 'apiBase', 'name']);
  await chrome.scripting.unregisterContentScripts({ ids: ['claude-page'] }).catch(() => {});
  await paintStatus();
}

async function pair(server, code, name) {
  server = String(server || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(server)) fail('Vul het adres van Claude Chat in, bijvoorbeeld https://claude.voorbeeld.nl');
  const ua = navigator.userAgent.match(/Chrome\/([\d.]+)/);
  const body = { code: String(code).trim(), hostname: (name || 'Chrome').slice(0, 80), os: 'browser', osName: `Chrome ${ua ? ua[1] : ''}`.trim(), arch: '', version: VERSION };
  let last = null;
  for (const base of [`${server}/api`, server]) {
    let res;
    try { res = await fetch(`${base}/devices/agent/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); }
    catch (e) { fail(`Geen verbinding met ${server}: ${e.message}`); }
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) { last = `HTTP ${res.status}`; continue; }
    const j = await res.json().catch(() => ({}));
    if (!res.ok) fail(j.error || `Koppelen mislukt (HTTP ${res.status})`);
    await store.set({ apiBase: base, server, token: j.token, deviceId: j.deviceId, name: j.name, paused: false });
    void registerPageScript(server);
    void loop();
    return { name: j.name, deviceId: j.deviceId };
  }
  fail(`Server antwoordt niet als Claude Chat (${last})`);
}

// Koppelen in twee stappen: de Chrome-toestemmingsvraag sluit de popup, waardoor de popup zelf niet meer
// kan koppelen. De popup zet het verzoek daarom eerst in storage.session; zodra de toestemming er is
// (permissions.onAdded, of een bericht van de popup als die toch open bleef) koppelt de achtergrond.
let pendingRun = null;
function runPendingPair() {
  if (pendingRun) return pendingRun;
  pendingRun = (async () => {
    const { pendingPair: p } = await chrome.storage.session.get('pendingPair');
    if (!p) return null;
    await chrome.storage.session.remove('pendingPair');
    if (Date.now() - (p.at || 0) > 10 * 60000) return null;
    if (!(await chrome.permissions.contains({ origins: [p.origin] }))) return null;
    try {
      const r = await pair(p.server, p.code, p.name);
      await chrome.storage.session.remove(['pairError', 'pairForm']);
      return r;
    } catch (e) {
      const error = e.message || String(e);
      await chrome.storage.session.set({ pairError: error });
      return { error };
    }
  })().finally(() => { pendingRun = null; });
  return pendingRun;
}
chrome.permissions.onAdded.addListener(() => { void runPendingPair(); });

// ── Zijpaneel (sidepanel.html) ────────────────────────────────
// Het paneel toont het gesprek (eigen lichte weergave) en de statusbalk "Claude bedient deze tab".
// Berichten van een webpagina (content script, sender.tab gezet) mogen ALLEEN panel-open; alles anders is voor
// extensiepagina's (popup, zijpaneel).
async function panelState() {
  const s = await store.get();
  let tabId = [...asks.keys()][0];
  const ask = tabId !== undefined ? { tabId, nonce: asks.get(tabId).nonce } : null;
  if (tabId === undefined) tabId = [...attached.keys()][0];
  let tab = null;
  if (tabId !== undefined) { const t = await chrome.tabs.get(tabId).catch(() => null); if (t && tabOk(t)) { let host = ''; try { host = new URL(tabUrl(t)).hostname; } catch { /* */ } tab = { id: t.id, title: t.title || host, host }; } }
  return { linked: !!s.token, paused: !!s.paused, online, acting: attached.size > 0 || !!ask, tab, ask };
}
async function pushPanel() {
  try { await chrome.runtime.sendMessage({ type: 'panel-state', state: await panelState() }); } catch { /* paneel is niet open */ }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Moet synchroon in het gebruikersgebaar beginnen: sidePanel.open vóór elke await.
function panelOpen(msg, sender) {
  const conv = String(msg.conversationId || '');
  if (!UUID.test(conv)) fail('Ongeldig gesprek');
  if (sender.tab?.id === undefined) fail('Geen tabblad');
  const opened = chrome.sidePanel.open({ tabId: sender.tab.id });
  const saved = chrome.storage.session.set({ panelConv: conv, panelAt: Date.now() });
  return Promise.all([opened, saved]).then(() => ({ ok: true }));
}
async function registerPageScript(server) {
  try {
    const origin = new URL(server).origin + '/*';
    if (!(await chrome.permissions.contains({ origins: [origin] }))) return;
    const def = { id: 'claude-page', matches: [origin], js: ['content.js'], runAt: 'document_start', persistAcrossSessions: true };
    const have = await chrome.scripting.getRegisteredContentScripts({ ids: ['claude-page'] }).catch(() => []);
    if (have.length) await chrome.scripting.updateContentScripts([def]); else await chrome.scripting.registerContentScripts([def]);
    // al open staande tabbladen van de app krijgen het script ook (anders pas na verversen)
    const tabs = await chrome.tabs.query({ url: origin }).catch(() => []);
    for (const t of tabs) await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content.js'] }).catch(() => {});
  } catch { /* zonder paginascript geen zijpaneelknop in de app, de rest werkt */ }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  // Zijpaneel: sidePanel.open moet synchroon in het klikgebaar, dus vóór elke await. Daarna pas de herkomst controleren;
  // klopt die niet, dan gaat het paneel voor dat tabblad meteen weer dicht.
  if (_sender.tab && msg?.type === 'panel-open') {
    let opened;
    try { opened = panelOpen(msg, _sender); } catch (e) { reply({ error: e.message || String(e) }); return false; }
    (async () => {
      const s = await store.get();
      let ok = false; try { ok = !!s.server && new URL(_sender.tab.url).origin === new URL(s.server).origin; } catch { /* */ }
      if (!ok || !s.token) {
        await chrome.sidePanel.setOptions({ tabId: _sender.tab.id, enabled: false }).catch(() => {});
        await chrome.storage.session.remove(['panelConv']).catch(() => {});
        fail('Deze pagina mag het zijpaneel niet openen');
      }
      return opened;
    })().then(reply, (e) => reply({ error: e.message || String(e) }));
    return true;
  }
  (async () => {
    if (_sender.tab) return { error: 'niet toegestaan' };
    if (msg?.type === 'panel-state') return undefined; // eigen broadcast
    if (msg?.type === 'panel-get') return { state: await panelState(), ...(await store.get().then((s) => ({ apiBase: s.apiBase, server: s.server, name: s.name }))), ...(await chrome.storage.session.get(['panelConv'])) };
    if (msg?.type === 'panel-stop') { stopTab(Number(msg.tabId)); return { ok: true }; }
    if (msg?.type === 'panel-ask') { answerAsk(Number(msg.tabId), String(msg.nonce), !!msg.ja); return { ok: true }; }
    if (msg?.type === 'pair') return pair(msg.server, msg.code, msg.name);
    if (msg?.type === 'pair-pending') return runPendingPair();
    if (msg?.type === 'state') { const s = await store.get(); return { linked: !!s.token, name: s.name, server: s.server, paused: !!s.paused, online, acting: attached.size > 0 }; }
    if (msg?.type === 'pause') { await store.set({ paused: !!msg.paused }); if (msg.paused) await detachAll(); await paintStatus(); return { ok: true }; }
    if (msg?.type === 'unlink') {
      const s = await store.get();
      if (s.token) await api('/unenroll', {}, s.token).catch(() => {});
      await unlink();
      return { ok: true };
    }
    return { error: 'onbekend bericht' };
  })().then(reply, (e) => reply({ error: e.message || String(e) }));
  return true;
});

// Service worker kan worden gestopt: wekker en opstart-hooks zetten de poll-lus weer aan.
chrome.alarms.create('keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(() => { void loop(); });
// Zelf koppelen: een zip uit Claude Chat bevat een eenmalige koppelcode (config.json). Niet gekoppeld en een
// nieuwe code? Dan koppelt de extensie zichzelf, zonder popup. Een code wordt maar één keer geprobeerd.
let autoPairing = false;
async function autoPair() {
  if (autoPairing) return;
  autoPairing = true;
  try {
    const s = await store.get();
    if (s.token) return;
    let conf = {};
    try { conf = await (await fetch(chrome.runtime.getURL('config.json'))).json(); } catch { return; }
    if (!conf.server || !conf.code || conf.code === s.usedCode) return;
    await store.set({ usedCode: conf.code });
    const origin = new URL(conf.server).origin + '/*';
    if (!(await chrome.permissions.contains({ origins: [origin] }))) return; // zonder toestemming koppelt de popup
    try { await pair(conf.server, conf.code, conf.name || 'Chrome'); await chrome.storage.session.remove('pairError'); }
    catch (e) { await chrome.storage.session.set({ pairError: `Automatisch koppelen mislukt: ${e.message || e}. Maak een nieuwe koppelcode.` }); }
  } finally { autoPairing = false; }
}

async function boot() {
  const targets = await chrome.debugger.getTargets().catch(() => []);
  for (const t of targets) if (t.attached && t.tabId !== undefined) await chrome.debugger.detach({ tabId: t.tabId }).catch(() => {});
  await paintStatus();
  const st = await store.get();
  if (st.token && st.server) void registerPageScript(st.server);
  else await autoPair();
  void loop();
}
chrome.runtime.onStartup.addListener(boot);
chrome.runtime.onInstalled.addListener(boot);
void boot();
