// Mock Microsoft login + Graph server; real database (throwaway user, removed afterwards).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import { pool } from '../db';

let server: Server;
let userId = '';
let polls = 0;
let refreshCalls = 0;
const fakeJwt = (claims: object) => `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`;
const ACCESS = fakeJwt({ tid: 'tenant-123', upn: 'admin@klant.nl' });

function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  return new Promise((res, rej) => {
    const t = () => (cond() ? res() : Date.now() > until ? rej(new Error('timeout')) : setTimeout(t, 50));
    t();
  });
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const f = new URLSearchParams(body);
      const json = (o: object, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
      if (req.url?.endsWith('/devicecode')) {
        assert.match(f.get('scope') ?? '', /offline_access/);
        return json({ device_code: 'DC', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin', expires_in: 900, interval: 1 });
      }
      if (req.url?.endsWith('/token') && f.get('grant_type')?.includes('device_code')) {
        polls++;
        if (polls < 2) return json({ error: 'authorization_pending' }, 400);
        return json({ access_token: ACCESS, refresh_token: 'RT1' });
      }
      if (req.url?.includes('/tenant-123/oauth2/v2.0/token') && f.get('grant_type') === 'refresh_token') {
        refreshCalls++;
        // the token must be limited to our own scope list, never .default (that also yields every other consented right)
        assert.ok(!(f.get('scope') ?? '').includes('.default'), 'refresh must not ask .default');
        assert.match(f.get('scope') ?? '', /Mail\.Read\.Shared/); // in every set, also the full one
        if (f.get('refresh_token') === 'RT1') return json({ access_token: 'GRAPH-AT', refresh_token: 'RT2' });
        // a tenant linked before the write rights: the new set needs consent, the old set still works
        if (f.get('refresh_token') === 'RO') {
          if (/ReadWrite|Send/.test(f.get('scope') ?? '')) return json({ error: 'unexpected write scope' }, 400);
          return json({ access_token: 'READ-AT' });
        }
        if (f.get('refresh_token') === 'OLD') {
          if (/Files\.ReadWrite\.All|Sites\.Read\.All/.test(f.get('scope') ?? '')) return json({ error: 'invalid_grant', error_description: 'AADSTS65001: The user or administrator has not consented' }, 400);
          return json({ access_token: 'LEGACY-AT', refresh_token: 'OLD2' });
        }
        return json({ error: 'invalid_grant', error_description: 'AADSTS700082: expired' }, 400);
      }
      if (req.url?.startsWith('/v1.0/organization')) return json({ value: [{ displayName: 'Klant BV' }] });
      json({ error: 'unknown' }, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.M365_LOGIN_BASE = base;
  process.env.M365_GRAPH_BASE = base;
  userId = (await pool.query(`INSERT INTO users (email, password_hash, name, role) VALUES ('m365-test-' || gen_random_uuid(), 'x', 't', 'user') RETURNING id`)).rows[0].id;
});

after(async () => {
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  server.close();
  await pool.end();
});

test('device login: code shown, polling until signed in, tenant saved as m365 connector', async () => {
  const { startDeviceLogin, deviceLoginStatus } = await import('./m365');
  const login = await startDeviceLogin(userId, 50);
  assert.equal(login.userCode, 'ABCD-EFGH');
  await waitFor(() => deviceLoginStatus(userId)?.status === 'done');
  assert.equal(deviceLoginStatus(userId)?.tenantName, 'Klant BV');
  const c = (await pool.query(`SELECT name, config FROM connectors WHERE user_id = $1 AND type = 'm365'`, [userId])).rows;
  assert.equal(c.length, 1);
  assert.equal(c[0].name, 'M365 Klant BV');
  assert.deepEqual(c[0].config, { tenantId: 'tenant-123', tenantName: 'Klant BV', account: 'admin@klant.nl' });
});

test('access token per run, rotated refresh token is stored, expired login is reported', async () => {
  const { graphAccessToken } = await import('./m365');
  const row = async () => (await pool.query(`SELECT credentials_enc, test_status, test_message FROM connectors WHERE user_id = $1 AND type = 'm365'`, [userId])).rows[0];
  assert.equal(await graphAccessToken(userId, 'tenant-123', (await row()).credentials_enc), 'GRAPH-AT');
  const { decrypt } = await import('./crypto');
  assert.equal(JSON.parse(decrypt((await row()).credentials_enc)).refresh_token, 'RT2');
  await assert.rejects(graphAccessToken(userId, 'tenant-123', (await row()).credentials_enc), /opnieuw/);
  assert.equal((await row()).test_status, 'error');
  assert.equal(refreshCalls, 2);
});

test('a tenant linked before the write rights keeps working on its old rights', async () => {
  const { graphAccessToken } = await import('./m365');
  const { encrypt } = await import('./crypto');
  const before = refreshCalls;
  assert.equal(await graphAccessToken(userId, 'tenant-123', encrypt(JSON.stringify({ refresh_token: 'OLD' }))), 'LEGACY-AT');
  assert.equal(refreshCalls - before, 3, 'new set first, then the older sets');
});

test('scopes manage mail (own + shared), OneDrive, SharePoint, calendar and deploy Intune apps; tenant stays read-only', async () => {
  const { M365_SCOPES } = await import('./m365');
  for (const s of ['Mail.ReadWrite', 'Mail.ReadWrite.Shared', 'Mail.Send', 'Mail.Send.Shared', 'Files.ReadWrite.All', 'Sites.ReadWrite.All', 'Calendars.ReadWrite', 'DeviceManagementApps.ReadWrite.All', 'Group.Read.All']) {
    assert.ok(M365_SCOPES.split(' ').includes(`https://graph.microsoft.com/${s}`), s);
  }
  assert.ok(!M365_SCOPES.includes('Directory.ReadWrite'), 'tenant directory stays read-only');
  assert.ok(!M365_SCOPES.includes('User.ReadWrite.All'), 'users stay read-only');
});

test('read mode asks a token with only read rights and never falls back to write rights', async () => {
  const { graphAccessToken, M365_READ_SCOPES, M365_SCOPES } = await import('./m365');
  const { encrypt } = await import('./crypto');
  assert.ok(!/ReadWrite|Send/.test(M365_READ_SCOPES), 'read set has no write rights');
  for (const s of M365_READ_SCOPES.split(' ')) assert.ok(M365_SCOPES.split(' ').includes(s), `consented at link: ${s}`);
  assert.equal(await graphAccessToken(userId, 'tenant-123', encrypt(JSON.stringify({ refresh_token: 'RO' })), 'read'), 'READ-AT');
  const before = refreshCalls;
  await assert.rejects(graphAccessToken(userId, 'tenant-123', encrypt(JSON.stringify({ refresh_token: 'OLD' })), 'read'), /koppeling|opnieuw/);
  assert.equal(refreshCalls - before, 1, 'no fallback to an older set');
});
