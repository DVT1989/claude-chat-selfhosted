import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRawEvent, newParseState, type ClaudeEvent } from './claudeCode';

// Replay of a stream-json fragment. The shapes (async launch text, SendMessage result, task-notifications with
// task-id / tool-use-id) are copied from a real session transcript of 20-11-2026 (Claude Code 2.1.326).
const CC = 'a515ad42ca53c0fbb';
const agents = new Map([['agent-builder', { id: 'own-builder', name: 'Builder' }], ['agent-designer', { id: 'own-designer', name: 'Designer' }]]);
const asst = (content: unknown[], parent: string | null = null) => ({ type: 'assistant', session_id: 's1', parent_tool_use_id: parent, message: { content } });
const user = (content: unknown) => ({ type: 'user', session_id: 's1', parent_tool_use_id: null, message: { content } });
const notif = (o: { taskId: string; toolUseId?: string; status: string; summary?: string; result?: string }) => user([{ type: 'text', text:
  `<task-notification>\n<task-id>${o.taskId}</task-id>\n${o.toolUseId ? `<tool-use-id>${o.toolUseId}</tool-use-id>\n` : ''}<output-file>/tmp/x.output</output-file>\n<status>${o.status}</status>\n<summary>${o.summary ?? 'Agent "x" finished'}</summary>\n${o.result !== undefined ? `<result>${o.result}</result>\n` : ''}</task-notification>` }]);
const LAUNCH = `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: ${CC} (internal ID - do not mention to user. Use SendMessage with to: '${CC}', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background.`;
const RESUMED = JSON.stringify({ success: true, message: 'Resuming agent a515ad4', resumedAgentId: CC, pin: { id: CC, name: CC, ref: '08fadd' } });

function run(lines: Array<Record<string, unknown>>, st = newParseState(agents)): ClaudeEvent[] {
  return lines.flatMap((l) => parseRawEvent(l, st));
}

test('agents: a SendMessage to a known agent becomes a resumed bubble of the same agent', () => {
  const st = newParseState(agents);
  const ev = run([
    asst([{ type: 'tool_use', id: 'T1', name: 'Agent', input: { subagent_type: 'agent-builder', description: 'Bouw X' } }]),
    user([{ type: 'tool_result', tool_use_id: 'T1', content: [{ type: 'text', text: LAUNCH }] }]),
    asst([{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } }], 'T1'),
    notif({ taskId: CC, toolUseId: 'T1', status: 'completed', result: 'Klaar.\nVraag aan Designer: kijk je mee?' }),
    asst([{ type: 'tool_use', id: 'S1', name: 'SendMessage', input: { to: CC, summary: 'Builder verder', message: 'Designer zegt: prima.\nMaak het af.' } }]),
    user([{ type: 'tool_result', tool_use_id: 'S1', content: [{ type: 'text', text: RESUMED }] }]),
    asst([{ type: 'tool_use', id: 'b2', name: 'Read', input: { file_path: '/a/b/c.ts' } }], 'T1'),
    asst([{ type: 'tool_use', id: 'b3', name: 'Edit', input: { file_path: '/a/b/d.ts' } }], 'S1'),
    notif({ taskId: CC, toolUseId: 'S1', status: 'completed', result: 'Afgerond.' }),
  ], st);
  const types = ev.map((e) => e.type);
  assert.deepEqual(types, ['agent_start', 'agent_meta', 'agent_activity', 'agent_activity', 'agent_result', 'agent_start', 'agent_activity', 'agent_activity', 'agent_activity', 'agent_result']);
  assert.deepEqual(ev[1], { type: 'agent_meta', toolUseId: 'T1', ccAgentId: CC, sessionId: 's1' });
  const resumed = ev[5] as Extract<ClaudeEvent, { type: 'agent_start' }>;
  assert.equal(resumed.toolUseId, 'S1');
  assert.equal(resumed.agentId, 'own-builder');
  assert.equal(resumed.agentName, 'Builder');
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.ccAgentId, CC);
  assert.equal(resumed.task, 'Designer zegt: prima.', 'task = first line of the message');
  // the immediate {"success":true,"resumedAgentId"} answer keeps the bubble open (background)
  assert.equal((ev[6] as { toolName: string }).toolName, 'background');
  // live steps under the old call id AND under the SendMessage id both go to the new bubble
  assert.equal((ev[7] as { toolUseId: string }).toolUseId, 'S1');
  assert.equal((ev[8] as { toolUseId: string }).toolUseId, 'S1');
  const done = ev[9] as Extract<ClaudeEvent, { type: 'agent_result' }>;
  assert.equal(done.toolUseId, 'S1');
  assert.equal(done.content, 'Afgerond.');
  assert.equal(done.isError, false);
  assert.equal(st.calls.size, 0);
});

test('agents: a sync Agent report with agentId, then a SendMessage by name in a later run', () => {
  const st = newParseState(agents);
  const ev = run([
    asst([{ type: 'tool_use', id: 'T2', name: 'Agent', input: { subagent_type: 'agent-designer', description: 'Review' } }]),
    user([{ type: 'tool_result', tool_use_id: 'T2', content: [{ type: 'text', text: `Goed zo.\nagentId: a1764cac442292b82 (use SendMessage with to: 'a1764cac442292b82', summary: '<5-10 word recap>' to continue this agent)\n<usage>subagent_tokens: 1</usage>` }] }]),
  ], st);
  assert.deepEqual(ev.map((e) => e.type), ['agent_start', 'agent_meta', 'agent_result']);
  assert.equal((ev[2] as { content: string }).content, 'Goed zo.');
  assert.equal((ev[2] as { ccAgentId?: string }).ccAgentId, 'a1764cac442292b82');
  // a later run only knows the name
  const ev2 = run([asst([{ type: 'tool_use', id: 'S2', name: 'SendMessage', input: { to: 'Designer', message: 'Nog een vraag' } }])]);
  assert.equal(ev2[0].type, 'agent_start');
  assert.equal((ev2[0] as { agentId: string }).agentId, 'own-designer');
  assert.equal((ev2[0] as { ccAgentId?: string }).ccAgentId, undefined);
});

test('agents: notification without tool-use-id finds the open bubble by task-id; unknown targets stay a tool call', () => {
  const st = newParseState(agents);
  run([
    asst([{ type: 'tool_use', id: 'T3', name: 'Agent', input: { subagent_type: 'agent-builder', description: 'X' } }]),
    user([{ type: 'tool_result', tool_use_id: 'T3', content: [{ type: 'text', text: LAUNCH }] }]),
  ], st);
  const ev = run([notif({ taskId: CC, status: 'stopped', summary: 'Background agent "X" didn\'t finish before the previous session ended' })], st);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].type, 'agent_result');
  assert.equal((ev[0] as { toolUseId: string }).toolUseId, 'T3');
  assert.equal((ev[0] as { isError: boolean }).isError, true);
  const other = run([asst([{ type: 'tool_use', id: 'S9', name: 'SendMessage', input: { to: 'someone-else', message: 'hoi' } }])], st);
  assert.equal(other[0].type, 'tool_use');
});

test('agents: SendMessage delivered to a running agent closes only the new bubble', () => {
  const st = newParseState(agents);
  run([
    asst([{ type: 'tool_use', id: 'T4', name: 'Agent', input: { subagent_type: 'agent-builder', description: 'X' } }]),
    user([{ type: 'tool_result', tool_use_id: 'T4', content: [{ type: 'text', text: LAUNCH }] }]),
  ], st);
  const ev = run([
    asst([{ type: 'tool_use', id: 'S4', name: 'SendMessage', input: { to: CC, message: 'Let op: ook mobiel' } }]),
    user([{ type: 'tool_result', tool_use_id: 'S4', content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Message queued for delivery' }) }] }]),
    asst([{ type: 'tool_use', id: 'b9', name: 'Bash', input: { command: 'ls' } }], 'T4'),
    notif({ taskId: CC, toolUseId: 'T4', status: 'completed', result: 'Klaar.' }),
  ], st);
  assert.deepEqual(ev.map((e) => `${e.type}:${(e as { toolUseId?: string }).toolUseId}`),
    ['agent_start:S4', 'agent_result:S4', 'agent_activity:T4', 'agent_result:T4']);
});

test('tools: a tool_result for an ordinary tool id gives a tool_result event, an agent id does not', () => {
  const st = newParseState(agents);
  const ev = run([
    asst([{ type: 'tool_use', id: 'T9', name: 'Agent', input: { subagent_type: 'agent-builder', description: 'X' } }, { type: 'tool_use', id: 'B9', name: 'Bash', input: { command: 'ls' } }]),
    user([{ type: 'tool_result', tool_use_id: 'B9', content: [{ type: 'text', text: 'a.txt' }] }]),
    user([{ type: 'tool_result', tool_use_id: 'T9', content: [{ type: 'text', text: LAUNCH }] }]),
  ], st);
  const res = ev.filter((e) => e.type === 'tool_result') as Array<{ toolUseId?: string; content: string; isError: boolean }>;
  assert.equal(res.length, 1);
  assert.equal(res[0].toolUseId, 'B9');
  assert.equal(res[0].content, 'a.txt');
  assert.equal(res[0].isError, false);
});
