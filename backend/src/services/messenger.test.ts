import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeNumber } from './messenger';

test('normalizeNumber: international, 00, +, Dutch 06, rubbish', () => {
  assert.equal(normalizeNumber('+31 6-1234 5678'), '31612345678');
  assert.equal(normalizeNumber('0031612345678'), '31612345678');
  assert.equal(normalizeNumber('0612345678'), '31612345678');
  assert.equal(normalizeNumber('31612345678'), '31612345678');
  assert.equal(normalizeNumber('+44 (20) 7946 0958'), '442079460958');
  assert.equal(normalizeNumber('mama'), null);
  assert.equal(normalizeNumber('123'), null);
  assert.equal(normalizeNumber('31612345678; rm -rf'), null);
});
