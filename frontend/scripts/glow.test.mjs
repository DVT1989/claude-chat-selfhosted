// Run: node scripts/glow.test.mjs  (Node 22+/24 strips the TypeScript types itself)
import assert from 'assert';
import { glowGradient, uniqueOrdered, glowColor } from '../src/components/chat/agentGlowUtils.ts';

assert.equal(glowGradient([]), '');
assert.equal(glowGradient(['#111111']), 'linear-gradient(#111111, #111111)');
const seam2 = 'color-mix(in srgb, #222222 50%, #111111)';
assert.equal(glowGradient(['#111111', '#222222']), `conic-gradient(from var(--ag-a), ${seam2} 0%, #111111 10% 40%, #222222 60% 90%, ${seam2} 100%)`);
const g3 = glowGradient(['#aa0000', '#00bb00', '#0000cc']);
// centres at 1/6, 3/6, 5/6 of the circle
assert.ok(g3.includes('#aa0000 6.67% 26.67%'));
assert.ok(g3.includes('#00bb00 40% 60%'));
const g4 = glowGradient(['#aa0000', '#00bb00', '#0000cc', '#dddd00']);
assert.ok(g4.includes('#aa0000 5% 20%') && g4.includes('#dddd00 80% 95%'));
assert.ok(g4.startsWith('conic-gradient(from var(--ag-a), color-mix(in srgb, #dddd00 50%, #aa0000) 0%') && g4.endsWith(' 100%)'));
assert.deepEqual(uniqueOrdered(['#AA0000', '#bb0000', '#aa0000', '#bb0000', '#cc0000']), ['#AA0000', '#bb0000', '#cc0000']);
assert.deepEqual(uniqueOrdered([]), []);
assert.equal(glowColor('#12ab9F'), '#12ab9F');
assert.equal(glowColor('red'), 'var(--accent)');
assert.equal(glowColor(undefined), 'var(--accent)');
console.log('glow tests ok');
