import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { parseGithubUrl, findSkillDirs, sourceUrl } from './githubSkills';

test('githubSkills: parses repo, tree and blob links', () => {
  assert.deepEqual(parseGithubUrl('https://github.com/anthropics/skills'), { owner: 'anthropics', repo: 'skills', ref: null, path: '' });
  assert.deepEqual(parseGithubUrl('anthropics/skills'), { owner: 'anthropics', repo: 'skills', ref: null, path: '' });
  assert.deepEqual(parseGithubUrl('github.com/a/b.git/'), { owner: 'a', repo: 'b', ref: null, path: '' });
  assert.deepEqual(parseGithubUrl('https://github.com/a/b/tree/main/skills/pdf'), { owner: 'a', repo: 'b', ref: 'main', path: 'skills/pdf' });
  assert.deepEqual(parseGithubUrl('https://github.com/a/b/blob/v2/skills/pdf/SKILL.md'), { owner: 'a', repo: 'b', ref: 'v2', path: 'skills/pdf' });
  assert.equal(sourceUrl({ owner: 'a', repo: 'b', ref: null, path: '' }, 'skills/pdf'), 'https://github.com/a/b/tree/HEAD/skills/pdf');
});

test('githubSkills: rejects non-GitHub links and path tricks', () => {
  assert.throws(() => parseGithubUrl('https://gitlab.com/a/b'), /GitHub-link/);
  assert.throws(() => parseGithubUrl('https://github.com/a'), /repo-naam/);
  assert.throws(() => parseGithubUrl('https://github.com/a/b/tree/main/../../etc'), /pad/);
});

test('githubSkills: finds skill folders, does not descend into a skill or .git', () => {
  const root = mkdtempSync(join(tmpdir(), 'repo-'));
  for (const d of ['skills/pdf', 'skills/pdf/inner', 'skills/docx', '.git/x', 'README']) mkdirSync(join(root, d), { recursive: true });
  writeFileSync(join(root, 'skills/pdf/SKILL.md'), 'x');
  writeFileSync(join(root, 'skills/pdf/inner/SKILL.md'), 'x');
  writeFileSync(join(root, 'skills/docx/SKILL.md'), 'x');
  writeFileSync(join(root, '.git/x/SKILL.md'), 'x');
  const found = findSkillDirs(root).map((d) => relative(root, d).split('\\').join('/')).sort();
  assert.deepEqual(found, ['skills/docx', 'skills/pdf']);
  rmSync(root, { recursive: true, force: true });
});
