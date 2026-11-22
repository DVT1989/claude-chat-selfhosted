import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseAccount, load, lockHolds, LOCK_MIN_MS, parseOauthUsage, SWITCH_AT } from './claudeAccounts';

const acc = (slot: number, l: number, limitedUntil = 0) => ({ slot, load: l, limitedUntil });

test('claudeAccounts: account 1 is used while it is under the switch threshold', () => {
  assert.equal(SWITCH_AT, 95);
  assert.equal(chooseAccount([acc(0, 94.9), acc(1, 10)]).slot, 0);
});

test('claudeAccounts: at 95% or more the next account with room takes over', () => {
  assert.equal(chooseAccount([acc(0, 95), acc(1, 40)]).slot, 1);
  assert.equal(chooseAccount([acc(0, 99), acc(1, 97), acc(2, 20)]).slot, 2);
});

test('claudeAccounts: a limited account is skipped until its reset', () => {
  const now = 1_000_000;
  assert.equal(chooseAccount([acc(0, 10, now + 60_000), acc(1, 50)], now).slot, 1);
  assert.equal(chooseAccount([acc(0, 10, now - 1), acc(1, 50)], now).slot, 0);
});

test('claudeAccounts: all full → least used; all limited → first to free up', () => {
  assert.equal(chooseAccount([acc(0, 99), acc(1, 96)]).slot, 1);
  const now = 1_000_000;
  assert.equal(chooseAccount([acc(0, 99, now + 9_000), acc(1, 99, now + 3_000)], now).slot, 1);
});

test('claudeAccounts: load is the highest of session and week', () => {
  const u = parseOauthUsage({ five_hour: { utilization: 30, resets_at: null }, seven_day: { utilization: 96 } });
  assert.equal(load(u), 96);
  assert.equal(load(null), 0);
});

test('claudeAccounts: Claude Code limit notices are recognised', async () => {
  const { isRateLimitText } = await import('./claudeCode');
  assert.ok(isRateLimitText("you've hit your 5-hour limit · resets 2:10am (utc)"));
  assert.ok(isRateLimitText('weekly limit reached'));
  assert.ok(!isRateLimitText('de backup is klaar en alles draait'));
});

test('claudeAccounts: a limit lock lifts early once fresh usage shows room (account was reset)', () => {
  const now = 1_000_000_000;
  const u = (pct: number) => ({ session: { pct, resetAt: null }, weekly: { pct: 0, resetAt: null } });
  const lock = { until: now + 10 * 3600_000, at: now - LOCK_MIN_MS - 1 };
  assert.equal(lockHolds(lock, u(4), now), false, 'reset account is usable again');
  assert.equal(lockHolds(lock, u(100), now), true, 'still full: lock holds');
  assert.equal(lockHolds(lock, null, now), true, 'unknown usage: lock holds');
  assert.equal(lockHolds({ ...lock, at: now - 1000 }, u(4), now), true, 'just locked: usage may lag');
  assert.equal(lockHolds({ until: now - 1, at: now - 3600_000 }, u(100), now), false, 'past reset time');
  assert.equal(lockHolds(null, u(100), now), false);
});
