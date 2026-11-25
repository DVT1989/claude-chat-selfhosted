import { test } from 'node:test';
import assert from 'node:assert/strict';
import { m365RunMode } from './m365';

test('m365RunMode: main run write, opt-in per agent, lowest level wins', () => {
  assert.equal(m365RunMode({}, []), 'write');
  assert.equal(m365RunMode({}, ['a']), null);
  assert.equal(m365RunMode({ a: 'read' }, ['a']), 'read');
  assert.equal(m365RunMode({ a: 'write' }, ['a']), 'write');
  assert.equal(m365RunMode({ a: 'write', b: 'read' }, ['a', 'b']), 'read');
  assert.equal(m365RunMode({ a: 'write' }, ['a', 'b']), null);
});
