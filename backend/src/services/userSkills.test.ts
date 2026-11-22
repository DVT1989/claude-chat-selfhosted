import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { parseFrontmatter, prepareSkill, slugify, listOwnSkills, deleteOwnSkill, buildSkillMd } from './userSkills';

test('userSkills: frontmatter with quoted description round-trips', () => {
  const md = buildSkillMd('mail-check', 'Gebruik bij: "mail" vragen # niet stuk', 'Doe X.');
  const fm = parseFrontmatter(md);
  assert.equal(fm.name, 'mail-check');
  assert.equal(fm.description, 'Gebruik bij: "mail" vragen # niet stuk');
  assert.equal(fm.body.trim(), 'Doe X.');
});

test('userSkills: prepareSkill from form fields and from an uploaded SKILL.md', () => {
  const a = prepareSkill({ name: 'Mijn Skill!', description: 'Iets', instructions: 'Stap 1' });
  assert.equal(a.name, 'mijn-skill');
  assert.match(a.content, /^---\nname: mijn-skill\ndescription: "Iets"\n---/);
  const b = prepareSkill({ skillMd: '---\nname: uit-bestand\ndescription: Komt uit de file\n---\n# Kop\nTekst' });
  assert.equal(b.name, 'uit-bestand');
  assert.match(b.content, /description: "Komt uit de file"/);
  assert.match(b.content, /# Kop\nTekst/);
});

test('userSkills: prepareSkill rejects missing name, description or body', () => {
  assert.throws(() => prepareSkill({ name: '!!!', description: 'x', instructions: 'y' }), /naam/);
  assert.throws(() => prepareSkill({ name: 'ok', description: '', instructions: 'y' }), /beschrijving/);
  assert.throws(() => prepareSkill({ name: 'ok', description: 'x', instructions: '  ' }), /instructies/);
  assert.equal(slugify('Élan  Vital'), 'elan-vital');
});

test('userSkills: list and delete only touch real folders, never shared symlinks', () => {
  const home = mkdtempSync(join(tmpdir(), 'skills-'));
  const dir = join(home, '.claude', 'skills');
  mkdirSync(join(dir, 'eigen'), { recursive: true });
  writeFileSync(join(dir, 'eigen', 'SKILL.md'), buildSkillMd('eigen', 'Mijn skill', 'Doe iets'));
  const shared = join(home, 'shared', 'gedeeld');
  mkdirSync(shared, { recursive: true });
  writeFileSync(join(shared, 'SKILL.md'), buildSkillMd('gedeeld', 'Gedeeld', 'x'));
  symlinkSync(shared, join(dir, 'gedeeld'));

  assert.deepEqual(listOwnSkills(home).map((s) => s.name), ['eigen']);
  assert.equal(deleteOwnSkill(home, 'gedeeld'), false);
  assert.ok(existsSync(join(shared, 'SKILL.md')));
  assert.equal(readFileSync(join(shared, 'SKILL.md'), 'utf8').includes('gedeeld'), true);
  assert.equal(deleteOwnSkill(home, 'eigen'), true);
  assert.equal(existsSync(join(dir, 'eigen')), false);
  assert.equal(deleteOwnSkill(home, '../etc'), false);
  rmSync(home, { recursive: true, force: true });
});
