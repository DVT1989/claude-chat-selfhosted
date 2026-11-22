import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toTelegramChunks, markdownToTelegramHtml } from './format';

test('markdown becomes Telegram HTML, with escaping', () => {
  const html = markdownToTelegramHtml('# Titel\n\nDit is **vet**, *schuin* en `a<b>&c`.\n\n- een\n- twee\n\n[site](https://example.com/?a=1&b=2)');
  assert.equal(html,
    '<b>Titel</b>\n\nDit is <b>vet</b>, <i>schuin</i> en <code>a&lt;b&gt;&amp;c</code>.\n\n• een\n• twee\n\n'
    + '<a href="https://example.com/?a=1&amp;b=2">site</a>');
});

test('code blocks keep their content verbatim inside <pre>', () => {
  const html = markdownToTelegramHtml('Zie:\n\n```bash\necho "**niet vet**" && ls <dir>\n```\n\nKlaar.');
  assert.equal(html, 'Zie:\n\n<pre><code class="language-bash">echo "**niet vet**" &amp;&amp; ls &lt;dir&gt;</code></pre>\n\nKlaar.');
});

test('a structured answer keeps its text and shows each tool call as one line', () => {
  const content = JSON.stringify([
    { type: 'thinking', thinking: 'intern' },
    { type: 'tool_use', toolName: 'Bash', toolInput: { command: 'docker ps --format "{{.Names}}"', description: 'Containers' } },
    { type: 'tool_result', content: 'veel output', isError: false },
    { type: 'tool_use', toolName: 'Read', toolInput: { file_path: '/volume1/docker/app/config.yml' } },
    { type: 'text', text: 'Er draaien **16** containers.' },
  ]);
  const [msg] = toTelegramChunks(content);
  assert.equal(msg,
    '🔧 <i>Bash</i> <code>docker ps --format "{{.Names}}"</code>\n'
    + '🔧 <i>Read</i> <code>/volume1/docker/app/config.yml</code>\n\n'
    + 'Er draaien <b>16</b> containers.');
});

test('long answers are split between blocks, never inside a tag', () => {
  const para = 'woord '.repeat(150).trim();
  const md = Array.from({ length: 8 }, (_, i) => `**Deel ${i}** ${para}`).join('\n\n');
  const chunks = toTelegramChunks(md, 2000);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 2000);
    assert.equal((c.match(/<b>/g) ?? []).length, (c.match(/<\/b>/g) ?? []).length);
  }
});

test('a code block longer than the limit is split into several <pre> blocks', () => {
  const code = Array.from({ length: 400 }, (_, i) => `regel ${i}`).join('\n');
  const chunks = toTelegramChunks('```\n' + code + '\n```', 1000);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(c.length <= 1000);
    assert.ok(c.startsWith('<pre><code>') && c.endsWith('</code></pre>'));
  }
});

test('plain text and empty answers', () => {
  assert.deepEqual(toTelegramChunks('Alles draait.'), ['Alles draait.']);
  assert.deepEqual(toTelegramChunks(''), ['(leeg antwoord)']);
});
