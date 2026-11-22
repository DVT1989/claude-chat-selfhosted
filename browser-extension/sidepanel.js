// Zijpaneel: eigen lichte weergave van één gesprek van Claude Chat (geen iframe: de app staat framing niet toe).
// Verzoeken gaan met de bestaande inlog (cookie, credentials: include; de extensie heeft host-permissie voor
// het gekoppelde adres). Er wordt geen token of wachtwoord opgeslagen.
const $ = (id) => document.getElementById(id);
const msg = (m) => chrome.runtime.sendMessage(m);
let apiBase = '', server = '', conv = '', ctrl = null, retry = 0, busy = false, live = null, loggedOut = false;

function partialText(c) {
  if (typeof c !== 'string') return '';
  if (!c.startsWith('[')) return c;
  try { const a = JSON.parse(c); if (Array.isArray(a)) return a.filter((e) => e?.type === 'text' && e.text).map((e) => e.text).join('\n\n'); } catch { /* geen JSON */ }
  return c;
}
function bubble(role, text) {
  const d = document.createElement('div'); d.className = 'm ' + (role === 'user' ? 'u' : 'a'); d.textContent = text;
  $('log').appendChild(d); return d;
}
const toEnd = () => { const l = $('log'); l.scrollTop = l.scrollHeight; };
function note(t) { $('note').textContent = t || ''; $('note').hidden = !t; }
function empty(text, btnText, fn) {
  const l = $('log'); l.textContent = '';
  const d = document.createElement('div'); d.className = 'empty'; d.textContent = text;
  if (btnText) { const b = document.createElement('button'); b.className = 'btn'; b.textContent = btnText; b.onclick = fn; d.appendChild(document.createElement('br')); d.appendChild(b); }
  l.appendChild(d);
}
const openApp = (path) => chrome.tabs.create({ url: server + (path || '') });

async function call(path, init) {
  const r = await fetch(apiBase + path, { credentials: 'include', ...init });
  if (r.status === 401) { loggedOut = true; throw new Error('401'); }
  return r;
}

async function load() {
  $('form').hidden = !conv || loggedOut;
  if (!conv) return empty('Open in Claude Chat een gesprek en kies "In Chrome-zijpaneel tonen".');
  try {
    const r = await call('/conversations/' + conv);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    loggedOut = false; note('');
    $('title').textContent = j.conversation?.title || 'Claude Chat';
    const l = $('log'); l.textContent = '';
    const msgs = j.messages || [];
    for (const m of msgs) {
      if (m.role === 'assistant' && m.metadata?.streaming === true && m === msgs[msgs.length - 1]) continue; // live via de stream
      const t = m.role === 'user' ? m.content : partialText(m.content);
      if (t && t.trim()) bubble(m.role, t);
    }
    if (!l.children.length) empty('Nog geen berichten in dit gesprek.');
    live = null; toEnd(); $('form').hidden = !conv;
  } catch (e) {
    $('form').hidden = !conv || loggedOut;
    if (loggedOut) empty('Je bent niet ingelogd in Claude Chat in deze browser.', 'Claude Chat openen', () => openApp());
    else empty('Kan het gesprek niet laden (' + e.message + ').', 'Opnieuw proberen', () => void load());
  }
}

// SSE lezen: subscribe (GET zonder bericht, speelt de lopende beurt af) of start-of-join (POST met bericht)
function onEvent(ev, data) {
  if (ev === 'run_start') {
    $('log').querySelector('.empty')?.remove();
    const last = [...$('log').querySelectorAll('.m.u')].pop();
    if (data.userMessage && last?.textContent !== data.userMessage) bubble('user', data.userMessage);
    live = { el: bubble('assistant', ''), text: '' }; live.el.hidden = true; busy = true; $('act')?.remove();
  } else if (ev === 'text') {
    if (!live) { live = { el: bubble('assistant', ''), text: '' }; busy = true; }
    const t = data.text || '';
    if (t && live.gap && live.text && !/\s$/.test(live.text)) live.text += '\n\n'; // nieuw tekstblok na een tool-stap
    if (t) live.gap = false;
    live.text += t; live.el.textContent = live.text; live.el.hidden = !live.text; toEnd();
  } else if (ev === 'tool_use') {
    if (live) live.gap = true;
    let a = $('act'); if (!a) { a = document.createElement('div'); a.id = 'act'; a.className = 'act'; $('log').appendChild(a); }
    a.textContent = 'Bezig met ' + (data.toolName || 'een stap') + '…'; toEnd();
  } else if (ev === 'error') { note(data.message || 'Er ging iets mis.'); }
  else if (ev === 'rate_limited') { note(data.message || 'Gebruikslimiet bereikt.'); }
  else if (ev === 'done') { busy = false; $('act')?.remove(); void load(); }
}
async function follow(message) {
  if (ctrl) ctrl.abort();
  const my = ctrl = new AbortController();
  try {
    const init = message
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message }), signal: my.signal }
      : { signal: my.signal };
    const r = await call('/conversations/' + conv + '/stream', init);
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'HTTP ' + r.status); }
    retry = 0;
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const blk = buf.slice(0, i); buf = buf.slice(i + 2);
        let ev = 'message', d = '';
        for (const ln of blk.split('\n')) { if (ln.startsWith('event:')) ev = ln.slice(6).trim(); else if (ln.startsWith('data:')) d += ln.slice(5).trim(); }
        if (d) { try { onEvent(ev, JSON.parse(d)); } catch { /* onbekend formaat */ } }
      }
    }
  } catch (e) {
    if (my.signal.aborted) return;
    if (loggedOut) { void load(); return; }
    if (message) note(String(e.message || e));
  }
  if (ctrl === my && !my.signal.aborted) { retry = Math.min(retry + 1, 6); setTimeout(() => { if (ctrl === my) void follow(); }, 1000 * retry); }
}

$('form').onsubmit = async (e) => {
  e.preventDefault();
  const t = $('input').value.trim(); if (!t || !conv) return;
  $('input').value = ''; fit(); note('');
  if (busy) {
    try { const r = await call('/conversations/' + conv + '/queue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: t }) }); if (!r.ok) throw new Error('HTTP ' + r.status); bubble('user', t); toEnd(); note('In de wachtrij: Claude pakt dit na het huidige antwoord op.'); }
    catch (err) { $('input').value = t; note('Versturen mislukt: ' + err.message); }
    return;
  }
  bubble('user', t); toEnd(); void follow(t);
};
const fit = () => { const i = $('input'); i.style.height = 'auto'; i.style.height = Math.min(i.scrollHeight, 140) + 'px'; };
$('input').oninput = fit;
$('input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('form').requestSubmit(); } };
$('open').onclick = () => openApp(conv ? '/chat/' + conv : '');

// Statusbalk: Claude bedient een tabblad (zelfde Stop en toestemming als de overlay in de pagina)
function bar(s) {
  const show = !!s && s.linked && s.acting;
  $('bar').hidden = !show; if (!show) return;
  const name = s.tab ? (s.tab.title || s.tab.host) : 'dit tabblad';
  const ask = !!s.ask;
  $('bar').classList.toggle('ask', ask);
  $('bartxt').textContent = ask ? 'Claude wil in ' + name + ' werken.' : 'Claude bedient deze tab: ' + name;
  $('bartxt').title = $('bartxt').textContent;
  $('ja').hidden = !ask; $('nee').hidden = !ask; $('stop').hidden = ask;
  $('ja').onclick = () => msg({ type: 'panel-ask', tabId: s.ask.tabId, nonce: s.ask.nonce, ja: true });
  $('nee').onclick = () => msg({ type: 'panel-ask', tabId: s.ask.tabId, nonce: s.ask.nonce, ja: false });
  $('stop').onclick = () => msg({ type: 'panel-stop', tabId: s.tab?.id });
}
chrome.runtime.onMessage.addListener((m) => { if (m?.type === 'panel-state') bar(m.state); });

async function start(c) {
  conv = c || ''; busy = false; note(''); $('form').hidden = !conv;
  if (ctrl) ctrl.abort();
  await load();
  if (conv && !loggedOut) void follow();
}
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'session' && ch.panelConv && ch.panelConv.newValue !== conv) void start(ch.panelConv.newValue); });
(async () => {
  const g = await msg({ type: 'panel-get' });
  if (g?.error) return empty(g.error);
  apiBase = g.apiBase || ''; server = g.server || ''; bar(g.state);
  if (!g.state?.linked) { $('form').hidden = true; return empty('Deze browser is nog niet gekoppeld aan Claude Chat. Koppel hem via het icoon van de extensie.'); }
  await start(g.panelConv);
})();
