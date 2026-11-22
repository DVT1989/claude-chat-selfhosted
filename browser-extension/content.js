// Paginascript voor de gekoppelde Claude Chat-app (alleen op het adres waaraan deze browser is gekoppeld).
// Doet twee dingen: laat de app weten dat de extensie er is (ping/pong) en opent op verzoek het zijpaneel
// voor één gesprek (alleen een gesprek-id gaat door). Geen paginagegevens worden gelezen of doorgestuurd.
// Na het herladen of bijwerken van de extensie wordt dit script opnieuw in open tabbladen gezet. Het vorige
// exemplaar is dan dood (Extension context invalidated): dat ruimt het nieuwe exemplaar eerst op.
(() => {
  try { window.__claudeExtOff?.(); } catch { /* oud exemplaar al weg */ }
  const post = (m) => window.postMessage({ source: 'claude-ext', ...m }, location.origin);
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  const onMsg = (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (!d || d.source !== 'claude-page') return;
    if (!alive()) { window.removeEventListener('message', onMsg); return; }
    if (d.type === 'ping') post({ type: 'pong', version: chrome.runtime.getManifest().version });
    else if (d.type === 'open-panel') {
      try {
        chrome.runtime.sendMessage({ type: 'panel-open', conversationId: String(d.conversationId || '') })
          .then((r) => post({ type: 'panel-result', ok: !!r?.ok, error: r?.error }))
          .catch((err) => post({ type: 'panel-result', ok: false, error: String(err?.message || err) }));
      } catch (err) { post({ type: 'panel-result', ok: false, error: 'Extensie niet bereikbaar, ververs de pagina' }); }
    }
  };
  window.addEventListener('message', onMsg);
  window.__claudeExtOff = () => window.removeEventListener('message', onMsg);
  post({ type: 'pong', version: chrome.runtime.getManifest().version });
})();
