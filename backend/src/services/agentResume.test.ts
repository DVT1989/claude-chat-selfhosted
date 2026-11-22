import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRawEvent, newParseState, resetFromLimitText, isAgentLimitText } from './claudeCode';
import { agentResumeLine } from './scheduler';
import { interruptedAgents } from '../routes/stream';

// Texts copied from real task-notifications (20-11-2026)
const FAILED = `Agent "UI-verbeterpunten van Designer bouwen" failed: Agent terminated early due to an API error: You've hit your 5-hour limit · resets 12:50am (UTC) (error type rate_limit, HTTP 429, request id req_x, model sent to the API: claude-opus-5-5)`;
const CC = 'ae906a89dbe5b83d1';

test('agent resume: limit text and reset time', () => {
  assert.equal(isAgentLimitText(FAILED), true);
  assert.equal(isAgentLimitText('Agent "x" failed: Bash exited with 1'), false);
  const now = Date.UTC(2026, 10, 20, 22, 30); // 22:30 UTC -> next 00:50 UTC is tomorrow
  assert.equal(resetFromLimitText(FAILED, now), '2026-11-21T00:50:00.000Z');
  assert.equal(resetFromLimitText('resets 7:50pm (UTC)', Date.UTC(2026, 10, 20, 17, 0)), '2026-11-20T19:50:00.000Z');
  // other zone: 7pm in Amsterdam (UTC+1 in November) = 18:00 UTC
  assert.equal(resetFromLimitText('resets 7pm (Europe/Amsterdam)', Date.UTC(2026, 10, 20, 12, 0)), '2026-11-20T18:00:00.000Z');
  assert.equal(resetFromLimitText('no time here'), null);
});

test('agent resume: a failed notification by the limit becomes agent_interrupted, not an error bubble', () => {
  const st = newParseState(new Map([['agent-builder', { id: 'own-builder', name: 'Builder' }]]));
  const ev = [
    { type: 'assistant', session_id: 's', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'T1', name: 'Agent', input: { subagent_type: 'agent-builder', description: 'X' } }] } },
    { type: 'user', session_id: 's', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'T1', content: [{ type: 'text', text: `Async agent launched successfully.\nagentId: ${CC} (internal ID)` }] }] } },
    { type: 'user', session_id: 's', parent_tool_use_id: null, message: { content: [{ type: 'text', text: `<task-notification>\n<task-id>${CC}</task-id>\n<tool-use-id>T1</tool-use-id>\n<status>failed</status>\n<summary>${FAILED}</summary>\n<note>The limit resets at 12:50am (UTC).</note>\n</task-notification>` }] } },
  ].flatMap((l) => parseRawEvent(l, st));
  const last = ev[ev.length - 1] as Record<string, unknown>;
  assert.equal(last.type, 'agent_interrupted');
  assert.equal(last.toolUseId, 'T1');
  assert.equal(last.agentName, 'Builder');
  assert.equal(last.ccAgentId, CC);
  assert.equal(typeof last.resetAt, 'string');
  assert.ok(!ev.some((e) => e.type === 'agent_result'));
  assert.equal(st.calls.size, 0);
});

test('agent resume: follow-up text and which stored bubbles count as cut off', () => {
  assert.equal(agentResumeLine({ name: 'Builder', ccAgentId: CC, reason: 'limit', since: 0 }),
    `Builder werd onderbroken door de limiet. Laat Builder verder gaan met SendMessage naar agentId ${CC}: kijk wat er al gedaan is en maak het af.`);
  const events = [
    { type: 'agent_start', toolUseId: 'A', agentId: 'own-builder', agentName: 'Builder', ccAgentId: 'c1' },
    { type: 'agent_start', toolUseId: 'B', agentId: 'own-designer', agentName: 'Designer', ccAgentId: 'c2' },
    { type: 'agent_result', toolUseId: 'B', content: 'Klaar', isError: false },
    { type: 'agent_start', toolUseId: 'C', agentId: 'own-mailer', agentName: 'Mailer', ccAgentId: 'c3' },
    { type: 'agent_result', toolUseId: 'C', content: 'Onderbroken', isError: true },
    { type: 'agent_start', toolUseId: 'D', agentId: 'own-timekeeper', agentName: 'Timekeeper', ccAgentId: 'c4' },
    { type: 'agent_interrupted', toolUseId: 'D', reason: 'limit' },
    { type: 'agent_start', toolUseId: 'E', agentId: 'own-bit', agentName: 'Bit' },
  ];
  assert.deepEqual(interruptedAgents(events).map((a) => a.agentName), ['Builder', 'Mailer']);
});
