import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orphanResumable, parseDeployMarker, resumeMessage, resumePlan, DEPLOY_MARKER_MS, MAX_RESUMES_PER_HOUR } from './resumePlan';

const NOW = Date.parse('2026-11-21T09:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60_000);
const asst = (metadata: Record<string, unknown>, min = 5) => ({ role: 'assistant', metadata, created_at: ago(min) });

test('resumePlan: a run killed during a tool call (still streaming at boot, marked interrupted) resumes', () => {
  assert.equal(resumePlan(asst({ interrupted: true }), { deploy: false, recentResumes: 0, now: NOW }), 'interrupted');
  assert.equal(resumePlan(asst({ interrupted: true }), { deploy: true, recentResumes: 0, now: NOW }), 'interrupted');
});

test('resumePlan: replay of today: answer finished with "Typ verder" before the helper restarted the backend', () => {
  // 07:37 selfupdate backend frontend, answer done (metadata {}), restart minutes later, Sam typed at 07:55
  const finished = asst({}, 3);
  assert.equal(resumePlan(finished, { deploy: false, recentResumes: 0, now: NOW }), null); // old behaviour: waits for "verder"
  assert.equal(resumePlan(finished, { deploy: true, recentResumes: 0, now: NOW }), 'deploy-check'); // now: continues by itself
});

test('resumePlan: no resume when the user spoke after the answer, when old, or in a crash loop', () => {
  assert.equal(resumePlan({ role: 'user', metadata: {}, created_at: ago(1) }, { deploy: true, recentResumes: 0, now: NOW }), null);
  assert.equal(resumePlan(undefined, { deploy: true, recentResumes: 0, now: NOW }), null);
  assert.equal(resumePlan(asst({}, 3 * 60), { deploy: true, recentResumes: 0, now: NOW }), null);
  assert.equal(resumePlan(asst({ interrupted: true }), { deploy: false, recentResumes: MAX_RESUMES_PER_HOUR, now: NOW }), null);
});

test('orphanResumable: long runs (over 30 minutes) killed by a restart still resume, abandoned ones not', () => {
  assert.equal(orphanResumable(ago(45), NOW), true);
  assert.equal(orphanResumable(ago(5 * 60), NOW), true);
  assert.equal(orphanResumable(ago(7 * 60), NOW), false);
});

test('parseDeployMarker: only a recent marker with a conversation id counts', () => {
  const id = '3f6d1990-c162-4c6a-bcbe-1101791e42a9';
  assert.equal(parseDeployMarker(JSON.stringify({ conversationId: id, at: NOW - 60_000 }), NOW), id);
  assert.equal(parseDeployMarker(JSON.stringify({ conversationId: id, at: NOW - DEPLOY_MARKER_MS - 1 }), NOW), null);
  assert.equal(parseDeployMarker(JSON.stringify({ conversationId: 'x; rm -rf', at: NOW }), NOW), null);
  assert.equal(parseDeployMarker(null, NOW), null);
  assert.equal(parseDeployMarker('{bad', NOW), null);
});

test('resumeMessage: never asks the user to type; a deploy asks Claude to check the rollout', () => {
  for (const m of [resumeMessage('deploy-check', true), resumeMessage('interrupted', true), resumeMessage('interrupted', false)]) {
    assert.doesNotMatch(m, /typ/i);
    assert.match(m, /^De backend is herstart/); // lastQuestion() filters these out as automatic
  }
  assert.match(resumeMessage('deploy-check', true), /selfupdate --log/);
  assert.match(resumeMessage('interrupted', true), /uitrol/);
  assert.doesNotMatch(resumeMessage('interrupted', false), /uitrol/);
});
