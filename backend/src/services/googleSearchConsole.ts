/**
 * Google Search Console as a per-user connector (type 'google-search-console').
 * One OAuth web client for the whole installation (admin setting, encrypted in app_settings, no rebuild needed);
 * every user signs in with Google and gets their own refresh token, encrypted in their own connector.
 * Scope is read-only. The access token is refreshed per run (see routes/stream.ts) and handed to Claude as a file.
 */
import { randomBytes } from 'crypto';
import { query } from '../db';
import { encrypt, decrypt } from './crypto';
import { config } from '../config';

export const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
export const GSC_TYPE = 'google-search-console';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SITES_URL = 'https://www.googleapis.com/webmasters/v3/sites';

export const redirectUri = () => process.env.GOOGLE_REDIRECT_URI ?? `${config.appUrl.replace(/\/$/, '')}/api/connectors/google/callback`;

// ── Installation-wide client (admin setting) ─────────────────
const SETTING_KEY = 'google_oauth_client';

export async function ensureSettingsTable(): Promise<void> {
  await query('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value_enc TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
}

export async function getClient(): Promise<{ clientId: string; clientSecret: string } | null> {
  const r = await query<{ value_enc: string }>('SELECT value_enc FROM app_settings WHERE key = $1', [SETTING_KEY]);
  if (!r.rows[0]) return null;
  try {
    const v = JSON.parse(decrypt(r.rows[0].value_enc)) as { clientId?: string; clientSecret?: string };
    return v.clientId && v.clientSecret ? { clientId: v.clientId, clientSecret: v.clientSecret } : null;
  } catch { return null; }
}

export async function setClient(clientId: string, clientSecret: string): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value_enc) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value_enc = EXCLUDED.value_enc, updated_at = NOW()`,
    [SETTING_KEY, encrypt(JSON.stringify({ clientId, clientSecret }))],
  );
}

export async function clearClient(): Promise<void> {
  await query('DELETE FROM app_settings WHERE key = $1', [SETTING_KEY]);
}

// ── Sign-in (state = CSRF protection, bound to the user who started it) ──
const states = new Map<string, { userId: string; expires: number }>();
const STATE_TTL = 10 * 60_000;

function pruneStates(): void {
  const now = Date.now();
  for (const [k, v] of states) if (v.expires < now) states.delete(k);
}

export async function startLogin(userId: string): Promise<string> {
  const client = await getClient();
  if (!client) throw new Error('Google-inloggen is nog niet ingesteld. Vraag de beheerder.');
  pruneStates();
  const state = randomBytes(24).toString('base64url');
  states.set(state, { userId, expires: Date.now() + STATE_TTL });
  const p = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: GSC_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${AUTH_URL}?${p.toString()}`;
}

async function tokenRequest(body: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
    signal: AbortSignal.timeout(15_000),
  });
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

async function listSites(accessToken: string): Promise<string[]> {
  const r = await fetch(SITES_URL, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`Search Console gaf HTTP ${r.status}`);
  const j = (await r.json()) as { siteEntry?: Array<{ siteUrl: string }> };
  return (j.siteEntry ?? []).map(s => s.siteUrl);
}

/** Callback: trade the code for tokens and store them in this user's connector (one per user, replaced on a new login). */
export async function finishLogin(code: string, state: string): Promise<{ userId: string; sites: number }> {
  pruneStates();
  const st = states.get(state);
  states.delete(state);
  if (!st || st.expires < Date.now()) throw new Error('De inlogpoging is verlopen of ongeldig. Probeer het opnieuw.');
  const client = await getClient();
  if (!client) throw new Error('Google-inloggen is niet ingesteld.');
  const t = await tokenRequest({
    code, client_id: client.clientId, client_secret: client.clientSecret,
    redirect_uri: redirectUri(), grant_type: 'authorization_code',
  });
  const refresh = String(t.refresh_token ?? '');
  const access = String(t.access_token ?? '');
  if (!refresh || !access) throw new Error(String(t.error_description ?? t.error ?? 'Google gaf geen refresh-token'));
  if (!String(t.scope ?? '').includes('webmasters')) throw new Error('Toegang tot Search Console is niet verleend.');
  const sites = await listSites(access);
  const enc = encrypt(JSON.stringify({ refresh_token: refresh }));
  const cfg = JSON.stringify({ sites, connectedAt: new Date().toISOString() });
  const existing = await query<{ id: string }>('SELECT id FROM connectors WHERE user_id = $1 AND type = $2 ORDER BY created_at LIMIT 1', [st.userId, GSC_TYPE]);
  if (existing.rows[0]) {
    await query(`UPDATE connectors SET credentials_enc = $1, config = $2, is_active = true, test_status = 'ok', test_message = $3, last_tested_at = NOW() WHERE id = $4`,
      [enc, cfg, `${sites.length} site(s) zichtbaar`, existing.rows[0].id]);
  } else {
    await query(`INSERT INTO connectors (user_id, name, type, credentials_enc, config, test_status, test_message, last_tested_at)
                 VALUES ($1, 'Search Console', $2, $3, $4, 'ok', $5, NOW())`,
      [st.userId, GSC_TYPE, enc, cfg, `${sites.length} site(s) zichtbaar`]);
  }
  return { userId: st.userId, sites: sites.length };
}

/** Fresh access token from the stored refresh token (about an hour valid). */
export async function accessTokenFor(credentialsEnc: string): Promise<string> {
  const client = await getClient();
  if (!client) throw new Error('Google-inloggen is niet meer ingesteld door de beheerder');
  const { refresh_token } = JSON.parse(decrypt(credentialsEnc)) as { refresh_token?: string };
  if (!refresh_token) throw new Error('Geen refresh-token, log opnieuw in met Google');
  const t = await tokenRequest({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token, grant_type: 'refresh_token' });
  if (!t.access_token) {
    const why = String(t.error ?? '');
    throw new Error(why === 'invalid_grant' ? 'Google-toegang is verlopen of ingetrokken, log opnieuw in met Google' : String(t.error_description ?? why ?? 'token vernieuwen mislukt'));
  }
  return String(t.access_token);
}

/** Connector test: refresh the token and list the sites. */
export async function testGsc(credentials: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  const refresh = String(credentials.refresh_token ?? '');
  if (!refresh) return { ok: false, message: 'Niet ingelogd met Google' };
  const client = await getClient();
  if (!client) return { ok: false, message: 'Google-inloggen is niet ingesteld' };
  const t = await tokenRequest({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' });
  if (!t.access_token) return { ok: false, message: t.error === 'invalid_grant' ? 'Toegang verlopen of ingetrokken, log opnieuw in met Google' : String(t.error_description ?? t.error ?? 'token vernieuwen mislukt') };
  const sites = await listSites(String(t.access_token));
  return { ok: true, message: sites.length ? `${sites.length} site(s): ${sites.slice(0, 3).join(', ')}${sites.length > 3 ? ', ...' : ''}` : 'Verbonden, maar dit account heeft nog geen sites in Search Console' };
}

/** Fixed steps for the "Laat Claude het instellen" chat (browser skill). */
export function setupPrompt(): string {
  return [
    'Stel Google-inloggen voor Search Console in voor deze installatie, met mijn gekoppelde Chrome-browser (skill browser-beheer). Ik ben al ingelogd bij Google in die browser; staat hij offline of ben ik niet ingelogd, meld dat dan en stop.',
    'Vast stappenplan, werk ze af en meld per stap kort wat er gebeurde:',
    '1. Ga naar https://console.cloud.google.com/projectcreate en maak een nieuw privé-project "Claude Chat Search Console" (geen organisatie nodig).',
    '2. Zet de API aan: https://console.cloud.google.com/apis/library/searchconsole.googleapis.com (knop Enable, kies het nieuwe project).',
    '3. Consent screen: https://console.cloud.google.com/auth/overview, Get started: appnaam "Claude Chat", support-mail mijn Google-account, doelgroep External, contactmail hetzelfde. Voeg bij Data Access alleen de scope https://www.googleapis.com/auth/webmasters.readonly toe.',
    `4. Client: https://console.cloud.google.com/auth/clients/create, type Web application, naam "Claude Chat". Authorized redirect URI exact: ${redirectUri()}. Maak aan en lees Client ID en Client secret van het scherm.`,
    '5. Publiceren: https://console.cloud.google.com/auth/audience, Publish app, zodat de status In production is (anders verlopen refresh-tokens na 7 dagen).',
    '6. Sla Client ID en secret op via Instellingen > Koppelingen in Claude Chat (velden in de Google-wizard), of geef ze aan mij zodat ik ze daar invul. Zet ze nergens anders neer en herhaal het secret niet in de chat.',
    'Vraag bevestiging voordat je iets doet dat geld kost (facturatie koppelen is niet nodig) en doe geen stappen buiten dit plan.',
  ].join('\n');
}
