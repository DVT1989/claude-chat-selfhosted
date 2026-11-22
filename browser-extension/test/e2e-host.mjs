// Testhost voor de extensie: start Chromium (headless) met de extensie, koppelt met een koppelcode en blijft open
// zodat de /devices/claude-API van buiten kan worden aangeroepen. Gebruik: zie README-test in test/run.sh.
// Env: SERVER (adres van de backend, bv. http://backend-test:4000), CODE (koppelcode), HOLD (seconden, standaard 180).
import { chromium } from 'playwright';
import { createServer } from 'http';
import { cpSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'fs';

const SERVER = process.env.SERVER, CODE = process.env.CODE, HOLD = Number(process.env.HOLD || 180);
const PAGE = `<!doctype html><meta charset=utf-8><title>Testpagina</title><body style="font:20px sans-serif;padding:30px">
<h1>Testpagina Claude</h1><input id=naam placeholder="Naam" style="font-size:20px"> <button id=go style="font-size:20px;padding:8px 16px">Groet</button>
<p id=uit>nog niets</p><a id=tweede href="/tweede">Naar de tweede pagina</a>
<script>go.onclick=()=>{uit.textContent='Hallo '+naam.value}</script>`;
const PAGE2 = `<!doctype html><meta charset=utf-8><title>Tweede pagina</title><body><h1>Dit is pagina twee</h1>`;
createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(q.url === '/tweede' ? PAGE2 : PAGE); }).listen(8080);

// extensie kopieren en het adres van de testbackend als host-permissie toevoegen (in de echte flow doet het popup dat met een prompt)
mkdirSync('/tmp/ext', { recursive: true });
cpSync('/ext', '/tmp/ext', { recursive: true });
const m = JSON.parse(readFileSync('/tmp/ext/manifest.json', 'utf8'));
m.host_permissions = [new URL(SERVER).origin + '/*'];
writeFileSync('/tmp/ext/manifest.json', JSON.stringify(m));

const ctx = await chromium.launchPersistentContext('/tmp/profile', {
  channel: 'chromium', headless: true, viewport: { width: 1000, height: 700 },
  args: ['--disable-extensions-except=/tmp/ext', '--load-extension=/tmp/ext'],
});
const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
console.log('service worker:', sw.url());
// zoals het popup: een bericht naar de service worker (vanuit een extensiepagina)
const extId = new URL(sw.url()).host;
const pop = await ctx.newPage();
await pop.goto(`chrome-extension://${extId}/popup.html`);
const paired = await pop.evaluate(([s, c]) => chrome.runtime.sendMessage({ type: 'pair', server: s, code: c, name: 'Test-Chrome' }), [SERVER, CODE]);
await pop.close();
console.log('gekoppeld:', JSON.stringify(paired));
const page = await ctx.newPage();
await page.goto('http://localhost:8080/');
console.log('READY');
const msg = async (m) => { const x = await ctx.newPage(); await x.goto(`chrome-extension://${extId}/popup.html`); const r = await x.evaluate((mm) => chrome.runtime.sendMessage(mm), m); await x.close(); return r; };
let paused = false;
for (let i = 0; i < HOLD && !existsSync('/tmp/stop'); i++) {
  if (existsSync('/tmp/pause') !== paused) { paused = !paused; console.log('pauze', paused, JSON.stringify(await msg({ type: 'pause', paused }))); }
  await new Promise((r) => setTimeout(r, 1000));
}
for (const p of ctx.pages()) console.log('PAGE', p.url(), '|', (await p.title().catch(() => '')), '|', await p.locator('#uit').textContent().catch(() => ''));
await ctx.close();
process.exit(0);
