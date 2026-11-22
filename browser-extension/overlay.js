// Pagina-overlay van Claude (cursor, rand/gloed, toestemmings- en stopbalk). Wordt via Runtime.evaluate in het
// tabblad gezet (geen content script, geen extra rechten). Eén sessie = Claude werkt in dit tabblad:
// start (rand + cursor verschijnen) -> cursor glijdt naar doelen en klikt -> end (alles vervaagt).
// Alleen transform/opacity (WAAPI). prefers-reduced-motion: geen glijden, geen ademen, korte fades.
// Het resultaat van de knoppen gaat via de CDP-binding window.claudeChoice naar de extensie (met nonce).
function overlayMain() {
  if (window.__claudeUi) return window.__claudeUi;
  const C = '#D97757', CD = '#B4532F';
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const OUT = 'cubic-bezier(.23,1,.32,1)', INOUT = 'cubic-bezier(.77,0,.175,1)';
  const bind = window.claudeChoice;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;margin:0;padding:0;border:0;background:none;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = '<style>'
    + '.glow{position:fixed;inset:0;pointer-events:none;opacity:0;box-shadow:inset 0 0 0 2px rgba(217,119,87,.9),inset 0 0 28px rgba(217,119,87,.38)}'
    + '.cur{position:fixed;left:0;top:0;pointer-events:none;opacity:0;will-change:transform,opacity}'
    + '.wrap{position:fixed;top:12px;left:0;right:0;padding:0 12px;box-sizing:border-box;display:flex;justify-content:center;pointer-events:none;opacity:0}'
    + '.bar{pointer-events:auto;max-width:100%;box-sizing:border-box;flex-wrap:wrap;justify-content:center;display:flex;align-items:center;gap:10px;padding:7px 7px 7px 14px;border-radius:999px;background:#fff;color:#2b2a33;font:500 13px/18px system-ui,Segoe UI,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.22),0 0 0 1px rgba(217,119,87,.5)}'
    + '.dot{width:8px;height:8px;border-radius:50%;background:' + C + ';flex:none}'
    + 'button{font:600 12px/16px system-ui,Segoe UI,sans-serif;border:0;border-radius:999px;padding:6px 12px;cursor:pointer;background:' + CD + ';color:#fff}'
    + 'button.g{background:#ececf0;color:#2b2a33}button:focus-visible{outline:2px solid #2b2a33;outline-offset:2px}'
    + '[hidden]{display:none!important}'
    + '</style>'
    + '<div class="glow"></div>'
    + '<div class="wrap" role="status"><div class="bar"><span class="dot"></span><span class="txt"></span>'
    + '<button class="ja">Toestaan</button><button class="nee g">Niet nu</button><button class="stop g">Stop</button></div></div>'
    + '<div class="cur"><b style="position:absolute;left:-3px;top:-2px;width:24px;height:24px;transform-origin:4px 3px"><svg width="24" height="24" viewBox="0 0 24 24" style="overflow:visible;filter:drop-shadow(0 2px 4px rgba(0,0,0,.35))"><path d="M3.5 2.2 19.6 11.1c.8.4.7 1.6-.2 1.8l-6.4 1.6-3 5.9c-.4.8-1.6.7-1.8-.2L2.2 3.6c-.2-.9.6-1.7 1.3-1.4Z" fill="' + C + '" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg></b>'
    + '<span style="position:absolute;left:18px;top:20px;padding:2px 8px;border-radius:999px;background:' + CD + ';color:#fff;font:600 11px/16px system-ui,Segoe UI,sans-serif;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.25)">Claude</span></div>';
  const $ = (s) => root.querySelector(s);
  const glow = $('.glow'), wrap = $('.wrap'), cur = $('.cur'), pijl = cur.querySelector('b'), txt = $('.txt');
  const bJa = $('.ja'), bNee = $('.nee'), bStop = $('.stop');
  let active = false, nonce = '', x = Math.round(innerWidth / 2), y = Math.round(innerHeight / 2), anim = null, adem = null, gone = 0;
  cur.style.transform = 'translate3d(' + x + 'px,' + y + 'px,0)';
  const send = (t) => { try { if (bind) bind(JSON.stringify({ t, n: nonce })); } catch (e) { /* geen binding */ } };
  bJa.onclick = () => send('ja'); bNee.onclick = () => send('nee'); bStop.onclick = () => send('stop');
  const fade = (el, on, ms, extra) => { el.animate([{ opacity: on ? 0 : 1, ...(extra ? extra(!on) : {}) }, { opacity: on ? 1 : 0, ...(extra ? extra(on) : {}) }], { duration: reduce ? 1 : ms, easing: OUT }); el.style.opacity = on ? '1' : '0'; };
  const slide = (on) => ({ transform: 'translateY(' + (on ? 0 : -8) + 'px)' });
  const curNow = () => { const m = new DOMMatrixReadOnly(getComputedStyle(cur).transform); return [m.m41, m.m42]; };
  function mode(m) {
    const ask = m === 'ask';
    bJa.hidden = !ask; bNee.hidden = !ask; bStop.hidden = ask;
    txt.textContent = ask ? 'Claude wil in deze pagina werken.' : 'Claude bedient deze pagina';
    if (ask) bJa.focus({ preventScroll: true });
  }
  const api = {
    // rand + cursor verschijnen (cursor op de laatste plek of het midden)
    start() {
      clearTimeout(gone);
      if (active) return 0;
      active = true;
      if (!host.isConnected) document.documentElement.appendChild(host);
      mode('work');
      fade(glow, true, 400); fade(cur, true, 300, (o) => ({ transform: cur.style.transform + ' scale(' + (o ? 1 : .85) + ')' })); fade(wrap, true, 260, slide);
      if (!reduce) adem = glow.animate([{ opacity: 1 }, { opacity: .72 }, { opacity: 1 }], { duration: 4000, iterations: Infinity, easing: 'ease-in-out', delay: 450 });
      return 300;
    },
    // toestemming vragen (alleen in het tabblad waar de gebruiker zelf kijkt)
    ask(n) { nonce = String(n); const t = api.start(); mode('ask'); return t; },
    working() { mode('work'); return 0; },
    move(tx, ty) {
      api.start();
      let [fx, fy] = anim ? curNow() : [x, y];
      if (anim) anim.cancel();
      const d = Math.hypot(tx - fx, ty - fy);
      const dur = reduce || d < 2 ? 0 : Math.round(Math.min(650, Math.max(260, 170 + d * 0.42)));
      x = tx; y = ty; cur.style.transform = 'translate3d(' + tx + 'px,' + ty + 'px,0)';
      if (!dur) { anim = null; return 0; }
      // kwadratische curve met lichte zijwaartse buiging, één easing over het hele pad
      const bend = Math.min(60, d * 0.12), nx = -(ty - fy) / d, ny = (tx - fx) / d;
      const cx = (fx + tx) / 2 + nx * bend, cy = (fy + ty) / 2 + ny * bend, k = [];
      for (let i = 0; i <= 14; i++) { const t = i / 14, u = 1 - t; k.push({ transform: 'translate3d(' + (u * u * fx + 2 * u * t * cx + t * t * tx) + 'px,' + (u * u * fy + 2 * u * t * cy + t * t * ty) + 'px,0)' }); }
      anim = cur.animate(k, { duration: dur, easing: INOUT });
      anim.onfinish = () => { anim = null; };
      return dur;
    },
    click() {
      if (!active || reduce) return;
      pijl.animate([{ transform: 'scale(1)' }, { transform: 'scale(.82)' }, { transform: 'scale(1)' }], { duration: 220, easing: OUT });
      const r = document.createElement('div');
      r.style.cssText = 'position:fixed;left:' + (x - 18) + 'px;top:' + (y - 18) + 'px;width:36px;height:36px;border-radius:50%;border:2px solid ' + CD + ';background:' + C + '33;pointer-events:none';
      root.appendChild(r);
      r.animate([{ transform: 'scale(.35)', opacity: .9 }, { transform: 'scale(1.5)', opacity: 0 }], { duration: 480, easing: OUT }).onfinish = () => r.remove();
    },
    // einde van de beurt: alles vervaagt, daarna weg uit de pagina
    end() {
      if (!active) return 0;
      active = false; nonce = '';
      if (adem) { adem.cancel(); adem = null; }
      fade(glow, false, 500); fade(cur, false, 320); fade(wrap, false, 260, slide);
      clearTimeout(gone); gone = setTimeout(() => { if (!active) host.remove(); }, 560);
      return 560;
    },
  };
  return (window.__claudeUi = api);
}
const OVERLAY_JS = `(${overlayMain.toString()})()`;
