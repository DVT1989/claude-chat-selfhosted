import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagePreview } from './preview';

test('messagePreview: plain markdown is flattened to one line', () => {
  assert.equal(messagePreview('## Kop\n\n**Vet** en `code` met [link](https://x.nl)'), 'Kop Vet en code met link');
});

test('messagePreview: tool answers show the last text event, also from a truncated tail', () => {
  const full = JSON.stringify([
    { type: 'text', text: 'Ik kijk even.' },
    { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
    { type: 'text', text: 'Klaar: 3 bestanden.\nZie lijst.' },
  ]);
  assert.equal(messagePreview(full), 'Klaar: 3 bestanden. Zie lijst.');
  assert.equal(messagePreview(full.slice(30)), 'Klaar: 3 bestanden. Zie lijst.');
});

test('messagePreview: empty, tool-only and long input', () => {
  assert.equal(messagePreview(null), '');
  assert.equal(messagePreview(JSON.stringify([{ type: 'tool_use', name: 'Bash', input: {} }])), '');
  const long = messagePreview('a'.repeat(300), 20);
  assert.equal(long.length, 20);
  assert.ok(long.endsWith('…'));
});
