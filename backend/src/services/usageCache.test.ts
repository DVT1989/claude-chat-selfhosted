import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createUsageReader, FAIL_RETRY_MS, RATE_LIMIT_RETRY_MS, type FetchResult, type UsageRecord } from './usageCache';
import { readingAfter } from './claudeAccounts';

const reading = (pct: number) => ({ session: { pct, resetAt: '2026-11-21T18:00:00Z' }, weekly: { pct: 50, resetAt: null } });

function setup(results: FetchResult[], stored: Record<string, UsageRecord> = {}) {
  let t = 1_000_000;
  const calls: string[] = [];
  const store = { ...stored };
  const reader = createUsageReader({
    ttlMs: 60_000,
    now: () => t,
    async fetchUsage(dir) { calls.push(dir); const r = results.shift(); if (!r) throw new Error('network'); return r; },
    store: {
      async get(dir) { return store[dir] ?? null; },
      async set(dir, rec) { store[dir] = rec; },
      async del(dir) { delete store[dir]; },
    },
  });
  return { reader, calls, store, advance: (ms: number) => { t += ms; }, now: () => t };
}

test('usageCache: a failed fetch returns the previous reading with stale and fetchedAt', async () => {
  const s = setup([{ ok: true, value: reading(40) }, { ok: false, status: 500 }]);
  const first = await s.reader.read('/a');
  assert.equal(first?.session?.pct, 40);
  assert.equal(first?.stale, false);
  const firstAt = first?.fetchedAt;
  s.advance(61_000);
  const second = await s.reader.read('/a');
  assert.equal(second?.session?.pct, 40);
  assert.equal(second?.stale, true);
  assert.equal(second?.fetchedAt, firstAt);
});

test('usageCache: a thrown fetch (time-out, token trouble) also falls back', async () => {
  const s = setup([{ ok: true, value: reading(12) }]);
  await s.reader.read('/a');
  s.advance(61_000);
  const u = await s.reader.read('/a'); // fetchUsage throws now
  assert.equal(u?.session?.pct, 12);
  assert.equal(u?.stale, true);
});

test('usageCache: after a restart the last good reading comes from the store', async () => {
  const s = setup([{ ok: false, status: 429 }], { '/a': { value: reading(77), at: 900_000 } });
  const u = await s.reader.read('/a');
  assert.equal(u?.session?.pct, 77);
  assert.equal(u?.stale, true);
  assert.equal(u?.fetchedAt, new Date(900_000).toISOString());
  // after a 429 the next fetch waits longer
  s.advance(FAIL_RETRY_MS + 1);
  await s.reader.read('/a');
  assert.equal(s.calls.length, 1);
  s.advance(RATE_LIMIT_RETRY_MS);
  await s.reader.read('/a');
  assert.equal(s.calls.length, 2);
});

test('usageCache: nothing known and the fetch fails gives null', async () => {
  const s = setup([{ ok: false }]);
  assert.equal(await s.reader.read('/a'), null);
});

test('usageCache: a good reading is stored for the next start', async () => {
  const s = setup([{ ok: true, value: reading(5) }]);
  await s.reader.read('/a');
  assert.equal(s.store['/a']?.value.session?.pct, 5);
});

test('usageCache: swr answers at once from the store and refreshes in the background', async () => {
  const s = setup([{ ok: true, value: reading(33) }], { '/a': { value: reading(20), at: 1_000_000 - 10_000 } });
  const quick = await s.reader.read('/a', { swr: true });
  assert.equal(quick?.session?.pct, 20);
  assert.equal(quick?.stale, false); // 10 s old: not marked old
  await new Promise((r) => setImmediate(r));
  const next = await s.reader.read('/a', { swr: true });
  assert.equal(next?.session?.pct, 33);
});

test('usageCache: concurrent reads share one fetch', async () => {
  const s = setup([{ ok: true, value: reading(1) }]);
  await Promise.all([s.reader.read('/a'), s.reader.read('/a'), s.reader.read('/a')]);
  assert.equal(s.calls.length, 1);
});

test('claudeAccounts: a stale reading from before a limit lock cannot lift it', () => {
  const u = { ...reading(10), fetchedAt: new Date(1_000).toISOString() };
  assert.equal(readingAfter(u, 2_000), null);
  assert.equal(readingAfter(u, 500), u);
  assert.equal(readingAfter(reading(10), 0), null);
  assert.equal(readingAfter(null, 0), null);
});

test('usageCache: fresh fetches again after an answer, but not within the gap or a 429 backoff', async () => {
  const s = setup([{ ok: true, value: reading(10) }, { ok: true, value: reading(15) }, { ok: false, status: 429 }]);
  await s.reader.read('/a');
  await s.reader.read('/a', { fresh: true }); // 0 s later: within the gap
  assert.equal(s.calls.length, 1);
  s.advance(11_000);
  assert.equal((await s.reader.read('/a', { fresh: true }))?.session?.pct, 15);
  s.advance(11_000);
  const limited = await s.reader.read('/a', { fresh: true });
  assert.equal(limited?.stale, true);
  s.advance(11_000);
  await s.reader.read('/a', { fresh: true }); // backing off after the 429
  assert.equal(s.calls.length, 3);
});
