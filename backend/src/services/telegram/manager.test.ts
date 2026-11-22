// Integration: a mock Telegram Bot API server + the real database (one throwaway user, removed afterwards).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server } from 'http';
import type { AddressInfo } from 'net';
import { pool } from '../../db';
import { encrypt } from '../crypto';

const GOOD = '123456789:' + 'A'.repeat(35);
const BAD = '987654321:' + 'B'.repeat(35);
const CHAT = 4242;
let server: Server;
let userId: string;
const sent: Array<{ chat_id: number; text: string }> = [];
const profile: Record<string, string> = {};
let delivered = false;
let inflight = 0;
let maxInflightAfterSettle = 0;
let settled = false;

function waitFor(cond: () => Promise<boolean> | boolean, ms = 8000): Promise<void> {
  const until = Date.now() + ms;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      if (await cond()) return resolve();
      if (Date.now() > until) return reject(new Error('timeout'));
      setTimeout(tick, 100);
    };
    void tick();
  });
}

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const [, botPart, method] = (req.url ?? '').split('/');
      const token = botPart.replace(/^bot/, '');
      const json = (code: number, obj: object) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (token !== GOOD) return json(401, { ok: false, error_code: 401, description: 'Unauthorized' });
      const args = body ? JSON.parse(body) : {};
      if (method === 'getMe') return json(200, { ok: true, result: { id: 1, username: 'TestClaudeBot', first_name: profile.name ?? 'Oude naam' } });
      if (method === 'setMyCommands') { profile.commands = (args.commands as Array<{ command: string }>).map((c) => c.command).join(','); return json(200, { ok: true, result: true }); }
      if (method === 'setMyName') { profile.name = args.name; return json(200, { ok: true, result: true }); }
      if (method === 'setMyDescription') { profile.description = args.description; return json(200, { ok: true, result: true }); }
      if (method === 'setMyShortDescription') { profile.short = args.short_description; return json(200, { ok: true, result: true }); }
      if (method === 'sendChatAction') return json(200, { ok: true, result: true });
      if (method === 'sendMessage') { sent.push({ chat_id: args.chat_id, text: args.text }); return json(200, { ok: true, result: {} }); }
      if (method === 'getUpdates') {
        if (!delivered) {
          delivered = true;
          return json(200, { ok: true, result: [{ update_id: 10, message: { chat: { id: CHAT, first_name: 'Test' }, text: '/start K7Q2M9' } }] });
        }
        inflight++;
        if (settled) maxInflightAfterSettle = Math.max(maxInflightAfterSettle, inflight);
        setTimeout(() => { inflight--; json(200, { ok: true, result: [] }); }, 200);
        return;
      }
      json(404, { ok: false, error_code: 404, description: 'no method' });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await (await import('./manager')).ensureTelegramSchema();
  const u = await pool.query(`INSERT INTO users (email, password_hash, name, role) VALUES ('tg-test-' || gen_random_uuid(), 'x', 'TG test', 'user') RETURNING id`);
  userId = u.rows[0].id;
});

after(async () => {
  const { stopAllTelegram } = await import('./manager');
  await stopAllTelegram();
  await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  server.close();
  await pool.end();
});

test('enabled bot pairs on /start and answers the chat', async () => {
  const { reloadTelegram } = await import('./manager');
  await pool.query(`INSERT INTO telegram_links (user_id, enabled, bot_token_enc, bot_name, pair_code, pair_code_expires) VALUES ($1, true, $2, 'Anthron', 'K7Q2M9', now() + interval '15 minutes')`, [userId, encrypt(GOOD)]);
  await reloadTelegram(userId);
  await waitFor(async () => (await pool.query('SELECT chat_id FROM telegram_links WHERE user_id = $1', [userId])).rows[0].chat_id !== null);
  await waitFor(() => sent.length > 0);
  assert.equal(sent[0].chat_id, CHAT);
  assert.match(sent[0].text, /^Gekoppeld!/);
  const row = (await pool.query('SELECT chat_name, bot_username, status FROM telegram_links WHERE user_id = $1', [userId])).rows[0];
  assert.equal(row.chat_name, 'Test');
  assert.equal(row.bot_username, 'TestClaudeBot');
  assert.equal(row.status, 'ok');
  assert.equal(profile.name, 'Anthron');
  assert.match(profile.commands, /^resume,/);
  assert.match(profile.description, /Anthron/);
  assert.match(profile.short, /Anthron/);
  const off = (await pool.query('SELECT update_offset FROM telegram_links WHERE user_id = $1', [userId])).rows[0].update_offset;
  assert.equal(Number(off), 11);
  const code = (await pool.query('SELECT pair_code FROM telegram_links WHERE user_id = $1', [userId])).rows[0].pair_code;
  assert.equal(code, null); // used once
});

test('review: concurrent reloads never leave two pollers on one token', async () => {
  const { reloadTelegram } = await import('./manager');
  await Promise.all([reloadTelegram(userId), reloadTelegram(userId), reloadTelegram(userId)]);
  await new Promise((r) => setTimeout(r, 600));
  settled = true;
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok(maxInflightAfterSettle <= 1, `max in-flight getUpdates: ${maxInflightAfterSettle}`);
});

test('an invalid token stops the poller and shows an error status', async () => {
  const { reloadTelegram } = await import('./manager');
  await pool.query('UPDATE telegram_links SET bot_token_enc = $2 WHERE user_id = $1', [userId, encrypt(BAD)]);
  await reloadTelegram(userId);
  await waitFor(async () => (await pool.query('SELECT status FROM telegram_links WHERE user_id = $1', [userId])).rows[0].status === 'error');
  const msg = (await pool.query('SELECT status_message FROM telegram_links WHERE user_id = $1', [userId])).rows[0].status_message;
  assert.match(msg, /token/i);
});

test('waitForReply returns the final assistant text, or its error', async () => {
  const { waitForReply } = await import('./manager');
  const c = await pool.query(`INSERT INTO conversations (user_id, title) VALUES ($1, 't') RETURNING id`, [userId]);
  const m = await pool.query(`INSERT INTO messages (conversation_id, role, content, metadata) VALUES ($1, 'assistant', '', '{"streaming": true}') RETURNING id`, [c.rows[0].id]);
  setTimeout(() => { void pool.query(`UPDATE messages SET content = 'klaar', metadata = '{"streaming": false}' WHERE id = $1`, [m.rows[0].id]); }, 300);
  assert.equal(await waitForReply(m.rows[0].id, 100, 5000), 'klaar');
  const e = await pool.query(`INSERT INTO messages (conversation_id, role, content, metadata) VALUES ($1, 'assistant', '', '{"streaming": false, "error": "exit code 1"}') RETURNING id`, [c.rows[0].id]);
  await assert.rejects(waitForReply(e.rows[0].id, 100, 5000), /exit code 1/);
});

test('pair codes: wrong code burns attempts, expired code fails, right code is single-use', async () => {
  const { checkPairCode } = await import('./manager');
  await pool.query(`UPDATE telegram_links SET pair_code = 'ABCDEF', pair_code_expires = now() + interval '15 minutes', pair_attempts = 0 WHERE user_id = $1`, [userId]);
  for (let i = 0; i < 5; i++) assert.equal(await checkPairCode(userId, 'ZZZZZZ'), false);
  assert.equal(await checkPairCode(userId, 'ABCDEF'), false, 'locked after 5 wrong tries');
  await pool.query(`UPDATE telegram_links SET pair_code = 'ABCDEF', pair_code_expires = now() - interval '1 minute', pair_attempts = 0 WHERE user_id = $1`, [userId]);
  assert.equal(await checkPairCode(userId, 'ABCDEF'), false, 'expired');
  await pool.query(`UPDATE telegram_links SET pair_code = 'ABCDEF', pair_code_expires = now() + interval '15 minutes', pair_attempts = 0 WHERE user_id = $1`, [userId]);
  assert.equal(await checkPairCode(userId, 'abcdef'), true, 'case-insensitive');
  assert.equal(await checkPairCode(userId, 'ABCDEF'), false, 'single use');
});

test('waitForReply returns the stored answer; Telegram chunks keep text and tool lines', async () => {
  const { waitForReply } = await import('./manager');
  const c = await pool.query(`INSERT INTO conversations (user_id, title) VALUES ($1, 't2') RETURNING id`, [userId]);
  const events = [
    { type: 'tool_use', toolName: 'Bash', toolInput: { command: 'uptime' }, toolUseId: 't1' },
    { type: 'tool_result', toolUseId: 't1', content: 'up 23 days', isError: false },
    { type: 'text', text: 'De NAS draait al 23 dagen.' },
    { type: 'thinking', thinking: 'intern' },
    { type: 'text', text: 'Alles in orde.' },
  ];
  const m = await pool.query(`INSERT INTO messages (conversation_id, role, content, metadata) VALUES ($1, 'assistant', $2, '{"streaming": false}') RETURNING id`, [c.rows[0].id, JSON.stringify(events)]);
  const { toTelegramChunks } = await import('./format');
  const [msg] = toTelegramChunks(await waitForReply(m.rows[0].id, 100, 5000));
  assert.equal(msg, '🔧 <i>Bash</i> <code>uptime</code>\n\nDe NAS draait al 23 dagen.\n\nAlles in orde.');
});
