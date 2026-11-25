const $ = (id) => document.getElementById(id);
const msg = (m) => chrome.runtime.sendMessage(m);
const err = (t) => { $('err').textContent = t || ''; $('err').hidden = !t; };

let adding = false;
const hostOf = (u) => { try { return new URL(u).host; } catch { return u || ''; } };
async function render() {
  const s = await msg({ type: 'state' });
  const form = !s.linked || adding;
  $('linked').hidden = form;
  $('unlinked').hidden = !form;
  $('cancel').hidden = !(s.linked && adding);
  $('addHint').hidden = !(s.linked && adding);
  if (!form) {
    const n = s.links.length;
    $('status').textContent = s.paused ? `${s.name}: gepauzeerd, Claude mag niets bedienen` : s.acting ? `${s.name}: Claude bedient nu een tabblad` : s.online ? `${s.name}: gekoppeld${n > 1 ? ` met ${n} servers` : ''}` : `${s.name}: geen verbinding met de server`;
    $('pause').textContent = s.paused ? 'Claude weer toestaan' : 'Claude pauzeren';
    $('pause').dataset.paused = s.paused ? '1' : '';
    const box = $('links');
    box.textContent = '';
    for (const l of s.links) {
      const row = document.createElement('div'); row.className = 'ln';
      const dot = document.createElement('span'); dot.className = 'dot' + (l.online ? ' on' : ''); dot.title = l.online ? 'Verbonden' : 'Geen verbinding';
      const host = document.createElement('span'); host.className = 'host'; host.textContent = hostOf(l.server); host.title = `${l.server} (${l.name})`;
      row.append(dot, host);
      if (!l.perm) {
        const p = document.createElement('button'); p.textContent = 'Toestaan'; p.title = 'Chrome-toestemming voor dit adres';
        p.onclick = async () => { const o = new URL(l.server).origin + '/*'; if (await chrome.permissions.request({ origins: [o] }).catch(() => false)) { await msg({ type: 'relink' }); await render(); } };
        row.append(p);
      }
      const u = document.createElement('button'); u.className = 'ghost'; u.textContent = 'Ontkoppelen';
      u.onclick = async () => { await msg({ type: 'unlink', server: l.server }); await render(); };
      row.append(u);
      box.append(row);
    }
    void checkUpdate(s.links[0]);
  } else {
    const { pairForm: f, pairError } = await chrome.storage.session.get(['pairForm', 'pairError']);
    if (f) { $('server').value = f.server || ''; $('code').value = f.code || ''; $('name').value = f.name || 'Chrome'; }
    if (pairError) { err(pairError); await chrome.storage.session.remove('pairError'); }
  }
  if (!s.linked && !$('server').value) {
    try { $('server').value = (await (await fetch(chrome.runtime.getURL('config.json'))).json()).server || ''; } catch { /* geen config */ }
  }
}

$('add').onclick = async () => { adding = true; err(''); $('server').value = ''; $('code').value = ''; await render(); };
$('cancel').onclick = async () => { adding = false; err(''); await chrome.storage.session.remove('pairForm'); await render(); };
$('pair').onclick = async () => {
  err('');
  const server = $('server').value.trim().replace(/\/+$/, '');
  const code = $('code').value, name = $('name').value;
  let origin;
  try { origin = new URL(server).origin + '/*'; } catch { return err('Ongeldig adres.'); }
  let r;
  if (await chrome.permissions.contains({ origins: [origin] })) {
    r = await msg({ type: 'pair', server, code, name });
  } else {
    // De toestemmingsvraag van Chrome sluit deze popup. Daarom eerst het verzoek bewaren:
    // de achtergrond koppelt zodra de toestemming er is, ook als de popup al dicht is.
    await chrome.storage.session.set({ pendingPair: { server, code, name, origin, at: Date.now() } });
    let ok = false;
    try { ok = await chrome.permissions.request({ origins: [origin] }); } catch { /* */ }
    if (!ok) { await chrome.storage.session.remove('pendingPair'); return err('Toestemming voor dit adres is geweigerd.'); }
    r = await msg({ type: 'pair-pending' });
  }
  if (r?.error) { await chrome.storage.session.remove('pairError'); return err(r.error); }
  await chrome.storage.session.remove('pairForm');
  adding = false;
  await render();
};
// ingevulde velden bewaren, zodat ze er nog staan als de popup tussendoor sluit
for (const id of ['server', 'code', 'name']) $(id).addEventListener('input', () => {
  void chrome.storage.session.set({ pairForm: { server: $('server').value, code: $('code').value, name: $('name').value } });
});
// Nieuwere versie op de server? Dan een downloadknop. De zip bevat een verse koppelcode en de huidige naam.
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function checkUpdate(link) {
  const apiBase = link?.apiBase;
  if (!apiBase) return;
  try {
    const { version } = await (await fetch(`${apiBase}/devices/download/browser-extension/version`, { cache: 'no-store' })).json();
    const mine = chrome.runtime.getManifest().version;
    if (version && newer(version, mine)) { $('updText').textContent = `Versie ${version} is beschikbaar (nu ${mine}).`; $('upd').hidden = false; }
  } catch { /* geen verbinding: geen melding */ }
}
$('updBtn').onclick = async () => {
  err('');
  const { links } = await chrome.storage.local.get(['links']);
  const { apiBase, token } = (links && links[0]) || await chrome.storage.local.get(['apiBase', 'token']);
  try {
    const r = await fetch(`${apiBase}/devices/agent/browser-extension.zip`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'claude-chat-browser.zip';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await r.blob()); a.download = name; document.body.appendChild(a); a.click();
  } catch (e) { err(`Downloaden mislukt: ${e.message || e}`); }
};
$('pause').onclick = async () => { await msg({ type: 'pause', paused: !$('pause').dataset.paused }); await render(); };
void render();
