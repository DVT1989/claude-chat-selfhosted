// node --test dist/services/telegram/bot.test.js — pure logic, no network, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBot, BotDeps, Link, TgUpdate, TEXT, welcomeText, pairFirstText } from './bot';
import { splitMessage } from './format';

const OWNER = 111;
const STRANGER = 999;

function upd(chatId: number, text: string, id = 1): TgUpdate {
  return { update_id: id, message: { chat: { id: chatId, first_name: 'Sam' }, text } };
}

function fakes() {
  const sent: Array<{ chatId: number; text: string }> = [];
  const runs: Array<{ convId: string; text: string }> = [];
  const releases: Array<(v: string) => void> = [];
  const convs = [
    { id: 'c1', title: 'Finance app', updated_at: '2026-11-15T10:00:00Z' },
    { id: 'c2', title: 'NAS controle', updated_at: '2026-11-14T10:00:00Z' },
  ];
  const state = { paired: null as number | null, active: null as string | null, marked: [] as string[], created: 0 };
  let webBusy = false;
  let failNext = '';
  const deps: BotDeps = {
    send: async (chatId, text) => { sent.push({ chatId, text }); },
    listConversations: async () => convs,
    createConversation: async () => { state.created++; return 'new1'; },
    markTelegram: async (id) => { state.marked.push(id); },
    savePairing: async (_u, chatId) => { state.paired = chatId; },
    checkPairCode: async (_u, code) => code === 'K7Q2M9',
    setActive: async (_u, id) => { state.active = id; },
    startRun: async (_u, convId, text) => {
      if (webBusy) return { ok: false, busy: true };
      runs.push({ convId, text });
      if (failNext) { const m = failNext; failNext = ''; return { ok: true, reply: Promise.reject(new Error(m)) }; }
      return { ok: true, reply: new Promise<string>((r) => releases.push(r)) };
    },
  };
  return { deps, sent, runs, releases, state, setWebBusy: (b: boolean) => { webBusy = b; }, failWith: (m: string) => { failNext = m; } };
}

const paired = (active: string | null = null): Link => ({ userId: 'u1', chatId: OWNER, activeConversationId: active });

test('/start with the right code pairs the chat and welcomes', async () => {
  const f = fakes();
  const bot = createBot(f.deps);
  const link: Link = { userId: 'u1', chatId: null, activeConversationId: null };
  await bot.handleUpdate(link, upd(OWNER, '/start K7Q2M9'));
  assert.equal(f.state.paired, OWNER);
  assert.equal(link.chatId, OWNER);
  assert.equal(f.sent[0].text, TEXT.welcome);
});

test('unpaired: plain text gets no answer at all', async () => {
  const f = fakes();
  const bot = createBot(f.deps);
  await bot.handleUpdate({ userId: 'u1', chatId: null, activeConversationId: null }, upd(OWNER, 'hoi'));
  assert.equal(f.state.paired, null);
  assert.equal(f.sent.length, 0);
});

test('unpaired: /start without or with a wrong code does not pair', async () => {
  const f = fakes();
  const bot = createBot(f.deps);
  const link: Link = { userId: 'u1', chatId: null, activeConversationId: null };
  await bot.handleUpdate(link, upd(OWNER, '/start'));
  await bot.handleUpdate(link, upd(STRANGER, '/start AAAAAA'));
  assert.equal(f.state.paired, null);
  assert.equal(link.chatId, null);
  assert.deepEqual(f.sent.map((s) => s.text), [TEXT.pairFirst, TEXT.pairFirst]);
});

test('a foreign chat is ignored completely', async () => {
  const f = fakes();
  const bot = createBot(f.deps);
  await bot.handleUpdate(paired(), upd(STRANGER, '/gesprekken'));
  await bot.handleUpdate(paired(), upd(STRANGER, 'hallo'));
  await bot.idle();
  assert.equal(f.sent.length, 0);
  assert.equal(f.runs.length, 0);
});

test('/gesprekken lists numbered titles, /open picks one', async () => {
  const f = fakes();
  const bot = createBot(f.deps);
  const link = paired();
  await bot.handleUpdate(link, upd(OWNER, '/gesprekken'));
  assert.match(f.sent[0].text, /1\. Finance app/);
  assert.match(f.sent[0].text, /2\. NAS controle/);
  await bot.handleUpdate(link, upd(OWNER, '/open 2'));
  assert.equal(f.state.active, 'c2');
  assert.equal(link.activeConversationId, 'c2');
  assert.deepEqual(f.state.marked, ['c2']);
  assert.match(f.sent[1].text, /NAS controle/);
});

test('/open with an unknown number explains what to do', async () => {
  const f = fakes();
  const bot = createBot(f.deps);
  await bot.handleUpdate(paired(), upd(OWNER, '/open 99'));
  assert.equal(f.sent[0].text, TEXT.unknownNumber);
  assert.equal(f.state.active, null);
});

test('/open@BotName works like /open', async () => {
  const f = fakes();
  const bot = createBot(f.deps);
  const link = paired();
  await bot.handleUpdate(link, upd(OWNER, '/gesprekken@DaveClaudeBot'));
  await bot.handleUpdate(link, upd(OWNER, '/open@DaveClaudeBot 1'));
  assert.equal(f.state.active, 'c1');
});

test('plain text without an active conversation starts a new one and sends the reply', async () => {
  const f = fakes();
  const bot = createBot(f.deps);
  const link = paired();
  await bot.handleUpdate(link, upd(OWNER, 'Hoe staat de NAS ervoor?'));
  assert.equal(f.state.created, 1);
  assert.equal(link.activeConversationId, 'new1');
  assert.deepEqual(f.state.marked, ['new1']);
  assert.deepEqual(f.runs, [{ convId: 'new1', text: 'Hoe staat de NAS ervoor?' }]);
  f.releases[0]('Alles draait.');
  await bot.idle();
  assert.equal(f.sent.at(-1)!.text, 'Alles draait.');
});

test('a message while Claude is busy is queued once and sent after the reply', async () => {
  const f = fakes();
  const bot = createBot(f.deps);
  const link = paired('c1');
  await bot.handleUpdate(link, upd(OWNER, 'eerste'));
  await bot.handleUpdate(link, upd(OWNER, 'tweede'));
  await bot.handleUpdate(link, upd(OWNER, 'derde'));
  assert.ok(f.sent.some((s) => s.text === TEXT.queued));
  assert.ok(f.sent.some((s) => s.text === TEXT.queueFull));
  f.releases[0]('antwoord 1');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.runs.map((r) => r.text), ['eerste', 'tweede']);
  f.releases[1]('antwoord 2');
  await bot.idle();
  const replies = f.sent.map((s) => s.text).filter((t) => t.startsWith('antwoord'));
  assert.deepEqual(replies, ['antwoord 1', 'antwoord 2']);
});

test('busy in the web app gives a clear answer', async () => {
  const f = fakes();
  f.setWebBusy(true);
  const bot = createBot(f.deps);
  await bot.handleUpdate(paired('c1'), upd(OWNER, 'hoi'));
  await bot.idle();
  assert.equal(f.sent.at(-1)!.text, TEXT.busyElsewhere);
});

test('a failed run is reported instead of staying silent', async () => {
  const f = fakes();
  f.failWith('exit code 1');
  const bot = createBot(f.deps);
  await bot.handleUpdate(paired('c1'), upd(OWNER, 'hoi'));
  await bot.idle();
  assert.equal(f.sent.at(-1)!.text, 'Fout: exit code 1');
});

test('/nieuw clears the active conversation', async () => {
  const f = fakes();
  const bot = createBot(f.deps);
  const link = paired('c1');
  await bot.handleUpdate(link, upd(OWNER, '/nieuw'));
  assert.equal(f.state.active, null);
  assert.equal(link.activeConversationId, null);
  assert.equal(f.sent[0].text, TEXT.newConversation);
});

test('/status names the active conversation', async () => {
  const f = fakes();
  const bot = createBot(f.deps);
  await bot.handleUpdate(paired('c2'), upd(OWNER, '/status'));
  assert.match(f.sent[0].text, /NAS controle/);
});

test('splitMessage keeps parts under the limit, prefers line breaks, loses nothing', () => {
  assert.deepEqual(splitMessage('kort'), ['kort']);
  const text = Array.from({ length: 300 }, (_, i) => `regel ${i} ` + 'x'.repeat(20)).join('\n');
  const parts = splitMessage(text, 1000);
  assert.ok(parts.every((p) => p.length <= 1000));
  assert.equal(parts.join('\n'), text);
  const oneLong = 'y'.repeat(2500);
  const p2 = splitMessage(oneLong, 1000);
  assert.deepEqual(p2.map((p) => p.length), [1000, 1000, 500]);
  assert.deepEqual(splitMessage(''), ['(leeg antwoord)']);
});

test('review: startRun throwing still answers the user', async () => {
  const f = fakes();
  f.deps.startRun = async () => { throw new Error('db weg'); };
  const bot = createBot(f.deps);
  await bot.handleUpdate(paired('c1'), upd(OWNER, 'hoi'));
  await bot.idle();
  assert.equal(f.sent.at(-1)!.text, 'Fout: db weg');
});

test('review: /start from a group chat does not pair', async () => {
  const f = fakes();
  const bot = createBot(f.deps);
  const link: Link = { userId: 'u1', chatId: null, activeConversationId: null };
  await bot.handleUpdate(link, { update_id: 1, message: { chat: { id: -5, type: 'group', title: 'Groep' }, text: '/start K7Q2M9' } });
  assert.equal(f.state.paired, null);
  assert.equal(link.chatId, null);
});

test('review: a stopped bot sends nothing more and drops its queue', async () => {
  const f = fakes();
  const ctl = new AbortController();
  const bot = createBot(f.deps, ctl.signal);
  const link = paired('c1');
  await bot.handleUpdate(link, upd(OWNER, 'eerste'));
  await bot.handleUpdate(link, upd(OWNER, 'tweede'));
  const before = f.sent.length;
  ctl.abort();
  f.releases[0]('te laat');
  await bot.idle();
  assert.equal(f.sent.length, before);
  assert.equal(f.runs.length, 1);
});

test('the bot introduces itself with its own name, neutral without', () => {
  assert.match(welcomeText('Anthron'), /Anthron/);
  assert.match(pairFirstText('Anthron'), /Anthron/);
  assert.doesNotMatch(TEXT.welcome, /Anthron/);
  assert.doesNotMatch(TEXT.pairFirst, /Anthron/);
});

test('/resume lists the recent conversations, /resume <nr> continues one', async () => {
  const f = fakes();
  const bot = createBot(f.deps);
  const link = paired();
  await bot.handleUpdate(link, upd(OWNER, '/resume'));
  assert.match(f.sent[0].text, /1\. Finance app/);
  assert.match(f.sent[0].text, /\/resume <nr>/);
  await bot.handleUpdate(link, upd(OWNER, '/resume 2'));
  assert.equal(f.state.active, 'c2');
  assert.match(f.sent[1].text, /NAS controle/);
});

test('the command menu lists /resume first', async () => {
  const { COMMANDS } = await import('./bot');
  assert.equal(COMMANDS[0].command, 'resume');
  assert.ok(COMMANDS.every((c) => /^[a-z]+$/.test(c.command) && c.description.length > 0));
});

// ── Telegram and WhatsApp side by side ───────────────────────

test('/whatsapp <tekst> goes to the relay with line breaks kept, not to Claude', async () => {
  const f = fakes();
  const relayed: string[] = [];
  f.deps.relayTo = { command: 'whatsapp', send: async (_u, t) => { relayed.push(t); return 'Doorgestuurd naar WhatsApp.'; } };
  const bot = createBot(f.deps);
  await bot.handleUpdate(paired('c1'), upd(OWNER, '/whatsapp regel 1\nregel 2'));
  await bot.idle();
  assert.deepEqual(relayed, ['regel 1\nregel 2']);
  assert.equal(f.runs.length, 0);
  assert.equal(f.sent[0].text, 'Doorgestuurd naar WhatsApp.');
});

test('without relayTo /whatsapp is plain text for Claude', async () => {
  const f = fakes();
  const bot = createBot(f.deps);
  await bot.handleUpdate(paired('c1'), upd(OWNER, '/whatsapp hoi'));
  assert.equal(f.runs[0].text, '/whatsapp hoi');
  f.releases[0]('ok');
  await bot.idle();
});

test('afterReply gets question and answer once delivered', async () => {
  const f = fakes();
  const seen: string[][] = [];
  f.deps.afterReply = async (_u, conv, q, a) => { seen.push([conv, q, a]); };
  const bot = createBot(f.deps);
  await bot.handleUpdate(paired('c1'), upd(OWNER, 'vraag'));
  f.releases[0]('antwoord');
  await bot.idle();
  assert.deepEqual(seen, [['c1', 'vraag', 'antwoord']]);
});

test('a conversation switched on the other channel is followed (getActive)', async () => {
  const f = fakes();
  let saved: string | null = 'c2';
  f.deps.getActive = async () => saved;
  const bot = createBot(f.deps);
  const link = paired('c1');
  await bot.handleUpdate(link, upd(OWNER, 'hoi'));
  assert.equal(f.runs[0].convId, 'c2');
  f.releases[0]('ok');
  await bot.idle();
  saved = null; // /nieuw on the other channel
  await bot.handleUpdate(link, upd(OWNER, '/status'));
  assert.equal(f.sent.at(-1)!.text, TEXT.noActive);
});

test('/status shows the other channel', async () => {
  const f = fakes();
  f.deps.statusExtra = async () => 'WhatsApp: verbonden';
  const bot = createBot(f.deps);
  await bot.handleUpdate(paired('c1'), upd(OWNER, '/status'));
  assert.equal(f.sent[0].text, 'Actief gesprek: Finance app\n\nWhatsApp: verbonden');
});
