import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOauthUsage } from './usage';

test('OAuth usage maps five_hour/seven_day to session/weekly', () => {
  const u = parseOauthUsage({
    five_hour: { utilization: 29, resets_at: '2026-11-16T03:39:59Z' },
    seven_day: { utilization: 46, resets_at: '2026-11-18T08:59:59Z' },
    seven_day_opus: null,
  });
  assert.deepEqual(u, {
    session: { pct: 29, resetAt: '2026-11-16T03:39:59Z' },
    weekly: { pct: 46, resetAt: '2026-11-18T08:59:59Z' },
  });
});

test('missing windows and odd values', () => {
  assert.equal(parseOauthUsage(null), null);
  assert.equal(parseOauthUsage({ five_hour: null, seven_day: null }), null);
  assert.deepEqual(parseOauthUsage({ five_hour: { utilization: 130 }, seven_day: null }), {
    session: { pct: 100, resetAt: null }, weekly: null,
  });
});
