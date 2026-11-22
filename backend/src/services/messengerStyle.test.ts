import { test } from 'node:test';
import assert from 'node:assert/strict';
import { finalReplyText, thinkingMessage, messengerPrompt } from './messengerStyle';

test('messengerStyle: only the text after the last tool call is sent', () => {
  const stored = JSON.stringify([
    { type: 'text', text: 'Ik kijk even in de logs.' },
    { type: 'tool_use', name: 'Bash' },
    { type: 'text', text: 'Nog een check.' },
    { type: 'tool_use', name: 'Read' },
    { type: 'text', text: 'Gevonden: de backup van vannacht is gelukt.' },
  ]);
  assert.equal(finalReplyText(stored), 'Gevonden: de backup van vannacht is gelukt.');
});

test('messengerStyle: without text after the last tool, the last text is used', () => {
  const stored = JSON.stringify([{ type: 'text', text: 'Klaar met de update.' }, { type: 'tool_use', name: 'Bash' }]);
  assert.equal(finalReplyText(stored), 'Klaar met de update.');
});

test('messengerStyle: code blocks are dropped with a pointer to the web app', () => {
  assert.equal(finalReplyText('Zo werkt het:\n\n```bash\nls -la\n```\n\nDat was het.'), 'Zo werkt het:\n\nDat was het.\n\n(De code staat in de web-app.)');
  assert.match(finalReplyText('```js\nx()\n```'), /web-app/);
  assert.equal(finalReplyText('Gewoon tekst.'), 'Gewoon tekst.');
});

test('messengerStyle: thinking message and prompt', () => {
  assert.ok(thinkingMessage(() => 0).length > 5);
  assert.ok(thinkingMessage(() => 0.999).length > 5);
  const p = messengerPrompt('whatsapp', 'Sam de Vries');
  assert.match(p, /WhatsApp/);
  assert.match(p, /Sam/);
  assert.match(p, /geen codeblokken/);
});
