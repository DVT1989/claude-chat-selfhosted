import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { decide, type GuardPolicy } from './m365Guard';

const policy: GuardPolicy = { tenants: [{ alias: 'M365_Voorbeeld', access: { mail: 'write', uren: 'read' } }] };
const bash = (command: string, who?: string) => ({ tool_name: 'Bash', tool_input: { command }, ...(who ? { agent_type: who, agent_id: 'x1' } : {}) });

test('main thread keeps access', () => {
  assert.equal(decide(bash('cat .m365-M365_Voorbeeld.token'), policy), null);
});
test('subagent without entry is blocked on token, glob and Graph URL', () => {
  for (const c of ['cat .m365-M365_Voorbeeld.token', 'cat .m365-*', 'cat .m*', 'cat *.token', 'curl https://graph.microsoft.com/v1.0/me/calendarView']) {
    assert.ok(decide(bash(c, 'ander'), policy), c);
  }
  assert.ok(decide({ tool_name: 'Read', tool_input: { file_path: '/w/.m365-M365_Voorbeeld.token' }, agent_type: 'ander' }, policy));
  assert.ok(decide({ tool_name: 'Glob', tool_input: { pattern: '.m365-*' }, agent_type: 'ander' }, policy));
  assert.ok(decide({ tool_name: 'Bash', tool_input: { command: 'ls' }, agent_id: 'only-id' }, { tenants: [{ alias: 'a', access: {} }] }) === null);
});
test('unrelated calls pass', () => {
  assert.equal(decide(bash('ls -la; npm test', 'ander'), policy), null);
  assert.equal(decide({ tool_name: 'Write', tool_input: { content: 'graph.microsoft.com' }, agent_type: 'ander' }, policy), null);
});
test('write agent passes, read agent only reads', () => {
  assert.equal(decide(bash('curl -H "Authorization: Bearer $(cat .m365-M365_Voorbeeld.token)" https://graph.microsoft.com/v1.0/me/messages', 'mail'), policy), null);
  const post = 'curl -X POST -H "Authorization: Bearer $(cat .m365-M365_Voorbeeld.token)" https://graph.microsoft.com/v1.0/me/sendMail';
  assert.equal(decide(bash(post, 'mail'), policy), null);
  assert.equal(decide(bash('curl -H "Authorization: Bearer $(cat .m365-M365_Voorbeeld.token)" https://graph.microsoft.com/v1.0/me/messages', 'uren'), policy), null);
  assert.ok(decide(bash(post, 'uren'), policy));
});
test('hook process: deny json for subagent, silent for main', () => {
  const js = join(__dirname, 'm365Guard.js');
  const b64 = Buffer.from(JSON.stringify(policy)).toString('base64');
  const run = (i: object) => spawnSync('node', [js, b64], { input: JSON.stringify(i), encoding: 'utf8' });
  const deny = run(bash('cat .m365-M365_Voorbeeld.token', 'ander'));
  assert.equal(deny.status, 0);
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(run(bash('cat .m365-M365_Voorbeeld.token')).stdout, '');
});
