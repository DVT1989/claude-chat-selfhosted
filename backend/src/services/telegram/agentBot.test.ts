// node --test dist/services/telegram/agentBot.test.js: pure logic, no network, no database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentBot, cleanAgentAnswer, agentChatPrompt, parseMention, AGENT_TEXT, type AgentBotDeps, type AgentInfo, type ChatterInfo, type Coordination } from './agentBot';

const DESIGNER: AgentInfo = { id: 'a1', name: 'Designer', slug: 'designer', description: 'design' };
const BUILDER: AgentInfo = { id: 'a2', name: 'Builder', slug: 'builder', description: 'bouwen' };

function upd(chatId: number, text: string, type = 'private') {
  return { update_id: 1, message: { chat: { id: chatId, type, first_name: 'Piet' }, text } };
}

function fakes(agents: AgentInfo[], chatters: Record<number, ChatterInfo> = {}) {
  const sent: Array<{ chatId: number; text: string }> = [];
  const asked: Array<{ agent: string; text: string }> = [];
  const requests: Array<{ chatId: number; name: string }> = [];
  const state = { allowed: true, plan: { agents: [], reason: '' } as Coordination, coordinated: 0, reply: 'Het staat goed.' };
  const deps: AgentBotDeps = {
    send: async (chatId, text) => { sent.push({ chatId, text }); },
    getChatter: async (chatId) => chatters[chatId] ?? null,
    requestAccess: async (chatId, name) => { requests.push({ chatId, name }); chatters[chatId] = { id: `c${chatId}`, status: 'pending', name }; },
    allow: async () => state.allowed,
    agents: async () => agents,
    coordinate: async () => { state.coordinated++; return state.plan; },
    runAgent: async (_c, agent, text) => { asked.push({ agent: agent.slug, text }); return state.reply; },
  };
  return { deps, sent, asked, requests, state, chatters };
}
const approved = (id = 'c1'): ChatterInfo => ({ id, status: 'approved', name: 'Piet' });

test('unknown chatter: request is stored, answer is "aanvraag verstuurd", nothing runs', async () => {
  const f = fakes([DESIGNER]);
  const bot = createAgentBot(f.deps);
  await bot.handleUpdate(upd(5, 'hoi'));
  await bot.idle();
  assert.deepEqual(f.requests, [{ chatId: 5, name: 'Piet' }]);
  assert.equal(f.sent[0].text, AGENT_TEXT.requested);
  assert.equal(f.asked.length, 0);
  // a second message while pending: no new request, nothing runs
  await bot.handleUpdate(upd(5, 'hallo?'));
  assert.equal(f.requests.length, 1);
  assert.equal(f.sent[1].text, AGENT_TEXT.stillPending);
  assert.equal(f.asked.length, 0);
});

test('denied and revoked chatters get no answer and nothing runs', async () => {
  const f = fakes([DESIGNER], { 1: { id: 'c1', status: 'denied', name: 'A' }, 2: { id: 'c2', status: 'revoked', name: 'B' } });
  const bot = createAgentBot(f.deps);
  await bot.handleUpdate(upd(1, 'hoi'));
  await bot.handleUpdate(upd(2, 'hoi'));
  await bot.idle();
  assert.equal(f.sent.length, 0);
  assert.equal(f.asked.length, 0);
});

test('approved chatter with one agent: direct answer with the agent name on top', async () => {
  const f = fakes([DESIGNER], { 7: approved() });
  const bot = createAgentBot(f.deps);
  await bot.handleUpdate(upd(7, 'Is de nieuwe kleur klaar?'));
  await bot.idle();
  assert.deepEqual(f.asked, [{ agent: 'designer', text: 'Is de nieuwe kleur klaar?' }]);
  assert.equal(f.state.coordinated, 0);
  assert.equal(f.sent[0].text, '**Designer**\n\nHet staat goed.');
});

test('group chats are ignored completely', async () => {
  const f = fakes([DESIGNER]);
  const bot = createAgentBot(f.deps);
  await bot.handleUpdate(upd(-100, 'hoi', 'supergroup'));
  assert.equal(f.sent.length + f.requests.length, 0);
});

test('@name addresses one agent without the coordinator', async () => {
  const f = fakes([DESIGNER, BUILDER], { 7: approved() });
  const bot = createAgentBot(f.deps);
  await bot.handleUpdate(upd(7, '@builder kun je de knop maken?'));
  await bot.idle();
  assert.deepEqual(f.asked, [{ agent: 'builder', text: 'kun je de knop maken?' }]);
  assert.equal(f.state.coordinated, 0);
  assert.ok(f.sent[0].text.startsWith('**Builder**'));
});

test('unknown @name lists the available agents and runs nothing', async () => {
  const f = fakes([DESIGNER, BUILDER], { 7: approved() });
  const bot = createAgentBot(f.deps);
  await bot.handleUpdate(upd(7, '@bob hoi'));
  await bot.idle();
  assert.equal(f.asked.length, 0);
  assert.match(f.sent[0].text, /@Designer, @Builder/);
});

test('without @name the coordinator picks the agents; each answers under its own name', async () => {
  const f = fakes([DESIGNER, BUILDER], { 7: approved() });
  f.state.plan = { agents: ['builder', 'designer', 'bestaatniet'], reason: '' };
  const bot = createAgentBot(f.deps);
  await bot.handleUpdate(upd(7, 'Kan de pagina mooier en sneller?'));
  await bot.idle();
  assert.equal(f.state.coordinated, 1);
  assert.deepEqual(f.asked.map((a) => a.agent), ['builder', 'designer']);
  assert.deepEqual(f.sent.map((s) => s.text.split('\n')[0]), ['**Builder**', '**Designer**']);
});

test('no agent can answer: the team explains why, under all their names', async () => {
  const f = fakes([DESIGNER, BUILDER], { 7: approved() });
  f.state.plan = { agents: [], reason: 'Dit gaat over belasting en dat doen wij niet.' };
  const bot = createAgentBot(f.deps);
  await bot.handleUpdate(upd(7, 'Wat is mijn btw-nummer?'));
  await bot.idle();
  assert.equal(f.asked.length, 0);
  assert.equal(f.sent[0].text, '**Designer en Builder**\n\nDit gaat over belasting en dat doen wij niet.');
});

test('coordinator failure gives a hint instead of a crash', async () => {
  const f = fakes([DESIGNER, BUILDER], { 7: approved() });
  f.deps.coordinate = async () => { throw new Error('limiet'); };
  const bot = createAgentBot(f.deps);
  await bot.handleUpdate(upd(7, 'hoi'));
  await bot.idle();
  assert.equal(f.sent[0].text, AGENT_TEXT.noCoordination);
});

test('rate limit stops the run and says so', async () => {
  const f = fakes([DESIGNER], { 7: approved() });
  f.state.allowed = false;
  const bot = createAgentBot(f.deps);
  await bot.handleUpdate(upd(7, 'nog een vraag'));
  await bot.idle();
  assert.equal(f.asked.length, 0);
  assert.equal(f.sent[0].text, AGENT_TEXT.rateLimited);
});

test('commands are not conversation; /start welcomes', async () => {
  const f = fakes([DESIGNER, BUILDER], { 7: approved() });
  const bot = createAgentBot(f.deps);
  await bot.handleUpdate(upd(7, '/rm -rf /'));
  await bot.handleUpdate(upd(7, '/start'));
  await bot.idle();
  assert.equal(f.asked.length, 0);
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /@Designer, @Builder/);
});

test('a second message during a run is not started in parallel', async () => {
  const f = fakes([DESIGNER], { 7: approved() });
  let release: (v: string) => void = () => undefined;
  f.deps.runAgent = () => new Promise<string>((r) => { release = r; });
  const bot = createAgentBot(f.deps);
  await bot.handleUpdate(upd(7, 'een'));
  await bot.handleUpdate(upd(7, 'twee'));
  assert.equal(f.sent[0].text, AGENT_TEXT.busy);
  release('klaar');
  await bot.idle();
  assert.equal(f.sent[1].text, '**Designer**\n\nklaar');
});

test('code filter: code blocks, inline ticks and shell lines never reach Telegram', async () => {
  const raw = 'Ik heb het gevonden.\n\n```bash\nsudo rm -rf /var/log\n```\n\nDe waarde staat in `config.ts` aan.\n$ ls -la\nKlaar.';
  const clean = cleanAgentAnswer(raw);
  assert.ok(!clean.includes('```'));
  assert.ok(!clean.includes('sudo rm'));
  assert.ok(!clean.includes('`'));
  assert.ok(!clean.includes('ls -la'));
  assert.match(clean, /config\.ts aan/);
  // answer that is only code
  assert.ok(!cleanAgentAnswer('```\nls\n```').includes('ls\n'));
  // tool-using run: only the text after the last tool counts, tool output is dropped
  const events = JSON.stringify([
    { type: 'text', text: 'Ik kijk even.' },
    { type: 'tool_use', toolName: 'Bash', toolInput: { command: 'cat /etc/passwd' } },
    { type: 'text', text: 'Alles is in orde.' },
  ]);
  assert.equal(cleanAgentAnswer(events), 'Alles is in orde.');
});

test('the filter is applied to what the bot sends', async () => {
  const f = fakes([DESIGNER], { 7: approved() });
  f.state.reply = 'Zo doe je het:\n```\nrm -rf /\n```';
  const bot = createAgentBot(f.deps);
  await bot.handleUpdate(upd(7, 'hoe?'));
  await bot.idle();
  assert.ok(!f.sent[0].text.includes('rm -rf'));
});

test('parseMention: case, accents and position do not matter', () => {
  assert.equal(parseMention('Hé @DESIGNER, wat vind je?', [DESIGNER, BUILDER]).agent?.slug, 'designer');
  assert.equal(parseMention('wat vind je @designer', [DESIGNER, BUILDER]).rest, 'wat vind je');
  assert.equal(parseMention('mail a@b.nl graag', [DESIGNER, BUILDER]).agent, null);
});

test('system prompt forbids commands, code and paths and carries the agent prompt', () => {
  const p = agentChatPrompt({ name: 'Designer', prompt: 'Je bent ontwerper.', knowledge: null }, 'Piet', 'Studiobot');
  assert.match(p, /Je bent ontwerper\./);
  assert.match(p, /commando's, codeblokken, code, bestandspaden/);
  assert.match(p, /Studiobot/);
});
