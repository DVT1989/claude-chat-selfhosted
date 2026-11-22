const $ = (id) => document.getElementById(id);
const msg = (m) => chrome.runtime.sendMessage(m);
const err = (t) => { $('err').textContent = t || ''; $('err').hidden = !t; };

async function render() {
  const s = await msg({ type: 'state' });
  $('linked').hidden = !s.linked;
  $('unlinked').hidden = s.linked;
  if (s.linked) {
    $('status').textContent = s.paused ? `${s.name}: gepauzeerd, Claude mag niets bedienen` : s.acting ? `${s.name}: Claude bedient nu een tabblad` : s.online ? `${s.name}: gekoppeld` : `${s.name}: geen verbinding met de server`;
    $('pause').textContent = s.paused ? 'Claude weer toestaan' : 'Claude pauzeren';
    $('pause').dataset.paused = s.paused ? '1' : '';
    void checkUpdate();
  } else {
    const { pairForm: f, pairError } = await chrome.storage.session.get(['pairForm', 'pairError']);
    if (f) { $('server').value = f.server || ''; $('code').value = f.code || ''; $('name').value = f.name || 'Chrome'; }
    if (pairError) { err(pairError); await chrome.storage.session.remove('pairError'); }
  }
  if (!s.linked && !$('server').value) {
    try { $('server').value = (await (await fetch(chrome.runtime.getURL('config.json'))).json()).server || ''; } catch { /* geen config */ }
  }
}

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
  await render();
};
// ingevulde velden bewaren, zodat ze er nog staan als de popup tussendoor sluit
for (const id of ['server', 'code', 'name']) $(id).addEventListener('input', () => {
  void chrome.storage.session.set({ pairForm: { server: $('server').value, code: $('code').value, name: $('name').value } });
});
// Nieuwere versie op de server? Dan een downloadknop. De zip bevat een verse koppelcode en de huidige naam.
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; };
async function checkUpdate() {
  const { apiBase } = await chrome.storage.local.get(['apiBase']);
  if (!apiBase) return;
  try {
    const { version } = await (await fetch(`${apiBase}/devices/download/browser-extension/version`, { cache: 'no-store' })).json();
    const mine = chrome.runtime.getManifest().version;
    if (version && newer(version, mine)) { $('updText').textContent = `Versie ${version} is beschikbaar (nu ${mine}).`; $('upd').hidden = false; }
  } catch { /* geen verbinding: geen melding */ }
}
$('updBtn').onclick = async () => {
  err('');
  const { apiBase, token } = await chrome.storage.local.get(['apiBase', 'token']);
  try {
    const r = await fetch(`${apiBase}/devices/agent/browser-extension.zip`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const name = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'claude-chat-browser.zip';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await r.blob()); a.download = name; document.body.appendChild(a); a.click();
  } catch (e) { err(`Downloaden mislukt: ${e.message || e}`); }
};
$('pause').onclick = async () => { await msg({ type: 'pause', paused: !$('pause').dataset.paused }); await render(); };
$('unlink').onclick = async () => { await msg({ type: 'unlink' }); await render(); };
void render();
