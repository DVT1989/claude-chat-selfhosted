import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crewOf, freeSlots, hasCutOffAgent, liveStep, MAX_RUNNING } from './delegations';

test('delegations: at most 3 at once per user, and none above the 80% line', () => {
  assert.equal(MAX_RUNNING, 3);
  assert.equal(freeSlots(0, true), 3);
  assert.equal(freeSlots(2, true), 1);
  assert.equal(freeSlots(3, true), 0);
  assert.equal(freeSlots(5, true), 0);
  assert.equal(freeSlots(0, false), 0, 'over 80%: everything waits in the queue');
});

test('delegations: an agent without a result means the workplace resumes later (interrupted)', () => {
  const start = { type: 'agent_start', toolUseId: 't1', agentId: 'a', agentName: 'Builder', ccAgentId: 'cc1' };
  assert.equal(hasCutOffAgent(JSON.stringify([start])), true);
  assert.equal(hasCutOffAgent(JSON.stringify([start, { type: 'agent_result', toolUseId: 't1', content: 'Onderbroken', isError: true }])), true);
  assert.equal(hasCutOffAgent(JSON.stringify([start, { type: 'agent_result', toolUseId: 't1', content: 'Klaar: 3 commits' }])), false);
  // resumed with SendMessage in a new bubble: only the latest bubble of that agent counts
  assert.equal(hasCutOffAgent(JSON.stringify([start, { type: 'agent_result', toolUseId: 't1', content: 'Onderbroken', isError: true },
    { ...start, toolUseId: 't2' }, { type: 'agent_result', toolUseId: 't2', content: 'Klaar' }])), false);
  assert.equal(hasCutOffAgent('gewoon tekst'), false);
});

test('delegations: the live step is the last agent step or tool, with the number of steps', () => {
  const h = [
    { event: 'text', data: { text: 'Ik geef het aan Builder' } },
    { event: 'agent_start', data: { toolUseId: 't1' } },
    { event: 'agent_activity', data: { toolName: 'Read', detail: 'ChatWindow.tsx', at: 1000 } },
    { event: 'agent_activity', data: { toolName: 'text', detail: '', at: 1500 } },
    { event: 'agent_activity', data: { toolName: 'Bash', detail: 'docker compose build', at: 2000 } },
  ];
  assert.deepEqual(liveStep(h), { step: { tool: 'Bash', detail: 'docker compose build', at: 2000 }, steps: 2 });
  const main = liveStep([{ event: 'tool_use', data: { toolName: 'Bash', toolInput: { command: 'ls', description: 'Lijst bestanden' } } }]);
  assert.deepEqual(main, { step: { tool: 'Bash', detail: 'Lijst bestanden', at: 0 }, steps: 1 });
  assert.deepEqual(liveStep([]), { step: null, steps: 0 });
});

test('delegations: crew and the agent at work (history and stored events)', () => {
  const h = [
    { event: 'agent_start', data: { toolUseId: 't1', agentId: 'builder', agentName: 'Builder' } },
    { event: 'agent_result', data: { toolUseId: 't1', content: 'Vraag aan Designer: kijk je mee?' } },
    { event: 'agent_start', data: { toolUseId: 't2', agentId: 'designer', agentName: 'Designer' } },
    { event: 'agent_activity', data: { toolUseId: 't2', toolName: 'Read' } },
  ];
  assert.deepEqual(crewOf(h), { crew: [{ id: 'builder', name: 'Builder' }, { id: 'designer', name: 'Designer' }], active: { id: 'designer', name: 'Designer' } });
  const back = [...h, { event: 'agent_result', data: { toolUseId: 't2' } }, { event: 'agent_start', data: { toolUseId: 't3', agentId: 'builder', agentName: 'Builder' } }];
  assert.deepEqual(crewOf(back).active, { id: 'builder', name: 'Builder' });
  assert.equal(crewOf(back).crew.length, 2);
  const stored = [{ type: 'agent_start', toolUseId: 'x', agentId: 'builder', agentName: 'Builder' }, { type: 'agent_result', toolUseId: 'x' }];
  assert.deepEqual(crewOf(stored), { crew: [{ id: 'builder', name: 'Builder' }], active: null });
});
