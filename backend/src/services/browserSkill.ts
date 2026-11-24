import { config } from '../config';

/** Name of the virtual server browser, e.g. "Browser (NAS)" with HOST_LABEL=NAS. */
export const NAS_NAME = `Browser (${config.hostLabel})`;
const NAS_URLNAME = encodeURIComponent(NAS_NAME);

/** Skill browser-beheer: API voor Claude om een gekoppelde Chrome-browser te bedienen (device type 'browser'). */
export const BROWSER_SKILL_DESCRIPTION = `Bedien een gekoppelde Chrome-browser of de ${NAS_NAME} (Chromium op de server, altijd online) van de gebruiker: tabbladen lijst, pagina lezen, navigeren, klikken, typen en screenshot. Gebruik bij browser, Chrome, tabblad, website openen, pagina lezen, formulier invullen, inloggen op een site.`;

export const browserSkillBody = (): string[] => [
  '# Browser (Chrome-extensie)',
  'Een gekoppelde browser is geen computer maar een koppeling (Koppelingen > Browser); in de API staat hij wel in `/devices/claude/list` (os "browser"). Zelfde token en dezelfde basis-URL als de skill apparaten-beheer. exec, file en info werken niet op een browser (409). Claude bedient alleen http(s)-pagina\'s; chrome://, extensiepagina\'s en file:// worden geweigerd. Zolang je een tabblad bedient toont Chrome een "AI"-badge en de balk "debugt deze browser"; de gebruiker kan pauzeren of ontkoppelen in de extensie.',
  '```bash',
  'DT() { echo "x-device-token: $(cat .devices.token)"; }',
  'B=http://127.0.0.1:4000/devices/claude/{id-of-naam}',
  'curl -s -H "$(DT)" $B/tabs                                   # {"tabs":[{id,windowId,active,title,url,controllable}]}',
  'curl -s -H "$(DT)" "$B/read?tab=123&max=15000"               # tab weglaten = actieve tab. {title,url,text,scroll,elements:[{ref,tag,text,href,x,y,inView,...}]}',
  'curl -s -H "$(DT)" "$B/screen?tab=123" -o pagina.jpg         # screenshot van het zichtbare deel, max 1280 breed; kijk met Read pagina.jpg',
  'curl -s -X POST -H "$(DT)" -H "Content-Type: application/json" $B/browser -d \'{"cmd":"open","url":"https://example.com"}\'',
  '#   cmd: open {url, background?} | navigate {url, tab?} | history {dir:"back"|"forward"|"reload", tab?} | close {tab?} | focus {tab?}',
  'curl -s -X POST -H "$(DT)" -H "Content-Type: application/json" $B/act -d \'{"tab":123,"actions":[{"click_ref":4},{"fill":{"ref":2,"text":"zoekterm"}},{"key":"enter"}]}\'',
  '# acties: {"click_ref":n} (ref uit read) | {"click_selector":"css"} | {"click":[x,y]} (pixels van laatste screen; + "button":"right", "double":true) | {"fill":{"ref":n|"selector":"css","text":"...","clear":true}}',
  '#         {"type":"tekst"} (in het focusveld) | {"key":"ctrl+a"} (enter esc tab backspace delete pijltjes home end pageup pagedown f1-f12 a-z 0-9, met ctrl alt shift) | {"scroll":[x,y,stappen]} | {"move":[x,y]} | {"drag":[x1,y1,x2,y2]} | {"wait":ms}',
  '```',
  'Werkwijze: gebruik read om te zien wat er staat en welke knoppen en velden er zijn (ref-nummers gelden voor de laatste read van dat tabblad: na navigatie of een grote wijziging opnieuw lezen). Gebruik screen als de opmaak ertoe doet of read te weinig laat zien; coordinaten voor click horen bij de laatste screen van dat tabblad. Controleer het resultaat na een actie met read of screen. Iframes en shadow-DOM staan niet in read: gebruik dan screen en click met coordinaten.',
  'AIO Dashboard (Daves eigen app, kind "aio" in de lijst) werkt hetzelfde: de tabs zijn de diensten van AIO (webviews) en FocusTrack. open maakt geen nieuw tabblad (alleen een bestaande dienst openen), close kan niet, een nog niet geladen tab wordt bij read geladen. Een gebruiker kan de besturing pauzeren of Stop drukken; dan krijg je een foutmelding en probeer je het niet opnieuw.',
  'Regels: voer uit wat de gebruiker vraagt. Vraag bevestiging voor je iets verstuurt, koopt, verwijdert of definitief opslaat, tenzij de gebruiker dat al vroeg. Typ geen wachtwoorden of codes die je niet van de gebruiker kreeg; velden van type password tonen geen waarde in read. Fout 409: browser offline of gepauzeerd, meld het en wacht niet. Fout 502: bericht van de extensie (bijvoorbeeld interne pagina of element niet gevonden). Alles wordt gelogd in de audit log (zonder getypte tekst).',
  '',
];

/** Browser (NAS): headless Chromium on the server, one per user, always online (device type 'nasbrowser'). */
export const nasBrowserSkillBody = (): string[] => [
  `# ${NAS_NAME}`,
  `Het apparaat "${NAS_NAME}" is een Chromium op de server (os "nasbrowser" in \`/devices/claude/list\`), eigen voor deze gebruiker en altijd online: er hoeft geen pc aan te staan. Hij start bij het eerste gebruik (een paar seconden) en sluit na 15 minuten zonder gebruik; logins blijven bewaard in een eigen profiel. De gebruiker kan meekijken en overnemen via Apparaten > ${NAS_NAME} > Openen, bijvoorbeeld voor 2FA: jij ziet dan wat hij typt niet, hij ziet jouw cursor. exec, file en info werken niet (409). Zelfde token en basis-URL als de skill apparaten-beheer.`,
  '```bash',
  'DT() { echo "x-device-token: $(cat .devices.token)"; }',
  `B=http://127.0.0.1:4000/devices/claude/{id-of-naam}          # naam: ${NAS_URLNAME}`,
  'curl -s -H "$(DT)" $B/tabs                                   # {"tabs":[{id,title,url,active}]}',
  'curl -s -H "$(DT)" "$B/read?max=15000"                       # actieve tab: {title,url,text,elements:[{tag,type,label,x,y}]}; x,y zijn pixels van screen',
  'curl -s -H "$(DT)" $B/screen -o pagina.jpg                   # screenshot 1280x800; kijk met Read pagina.jpg',
  'curl -s -X POST -H "$(DT)" -H "Content-Type: application/json" $B/browser -d \'{"cmd":"navigate","url":"https://example.com"}\'',
  '#   cmd: navigate {url} (ook een zoekterm of hostnaam) | open {url?} nieuw tabblad | history {dir:"back"|"forward"|"reload"} | close {tab?} | focus {tab}',
  'curl -s -X POST -H "$(DT)" -H "Content-Type: application/json" $B/act -d \'{"actions":[{"click":[640,400]},{"type":"tekst"},{"key":"enter"}]}\'',
  '# acties zoals op een pc-scherm: click [x,y] (+ button, double) | move | drag | scroll [x,y,stappen] | type | key (ctrl+a, enter, tab, ...) | wait',
  '```',
  `Werkwijze: navigate, dan read voor de tekst en de knoppen en velden (met coordinaten), of screen voor de opmaak. Act werkt met pixels van de laatste screen: maak eerst een screen (ook na navigeren). Controleer het resultaat met read of screen. Bij 2FA, captcha of een wachtwoord dat je niet hebt: vraag de gebruiker de browser over te nemen (Apparaten > ${NAS_NAME} > Openen) en wacht tot hij klaar is. Vraag bevestiging voor je iets verstuurt, koopt, verwijdert of definitief opslaat, tenzij de gebruiker dat al vroeg. Typ geen wachtwoorden of codes die je niet van de gebruiker kreeg. Fout 502: de browser kon niet starten of de actie mislukte (bericht staat erbij). Alles wordt gelogd in de audit log (zonder getypte tekst).`,
  '',
];
