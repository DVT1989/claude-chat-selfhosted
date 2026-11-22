import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tryAcquire, lockHolder, lockReason, withLock, belowShare, __resetLock, BACKGROUND_SHARE } from './backgroundJobs';

const usage = (session: number, weekly = 0) => ({ session: { pct: session, resetAt: null }, weekly: { pct: weekly, resetAt: null } });

test('backgroundJobs: one job at a time over learning, backfill, cleanup and training', () => {
  __resetLock();
  const release = tryAcquire('leerlus');
  assert.ok(release);
  assert.equal(lockHolder(), 'leerlus');
  for (const k of ['leerlus', 'inhalen', 'opruimen', 'training'] as const) assert.equal(tryAcquire(k), null, k);
  assert.equal(lockReason(), 'de leerlus is bezig');
  release!();
  release!(); // idempotent: a second release does not free a lock taken by someone else
  const t = tryAcquire('training');
  assert.ok(t);
  release!();
  assert.equal(lockHolder(), 'training');
  t!();
  assert.equal(lockHolder(), null);
});

test('backgroundJobs: withLock waits for nobody, it reports who is busy and always releases', async () => {
  __resetLock();
  const inner = await withLock('opruimen', async () => withLock('training', async () => 'nee'));
  assert.deepEqual(inner, { waiting: 'het opruimen is bezig' });
  assert.equal(lockHolder(), null);
  await assert.rejects(withLock('inhalen', async () => { throw new Error('stuk'); }));
  assert.equal(lockHolder(), null, 'released after an error');
  assert.equal(await withLock('leerlus', async () => 42), 42);
});

test('backgroundJobs: the 80% line looks at the session of the chosen account; the week only near its end', () => {
  assert.equal(BACKGROUND_SHARE, 0.8);
  assert.equal(belowShare([{ active: true, limited: false, usage: usage(79.9) }], 0.8), true);
  assert.equal(belowShare([{ active: true, limited: false, usage: usage(80) }], 0.8), false);
  assert.equal(belowShare([{ active: true, limited: false, usage: usage(10, 85) }], 0.8), true, 'week at 85%: still room');
  assert.equal(belowShare([{ active: true, limited: false, usage: usage(10, 96) }], 0.8), false, 'week near its end: stop');
  assert.equal(belowShare([{ active: true, limited: false, usage: usage(90, 50) }], 0.95, 0.98), true, 'delegation share');
  assert.equal(belowShare([{ active: true, limited: false, usage: null }], 0.8), true, 'no reading: free');
});

test('backgroundJobs: not the least-used account, but the one the next chat would use', () => {
  const list = [
    { active: false, limited: false, usage: usage(5) },
    { active: true, limited: false, usage: usage(90) },
  ];
  assert.equal(belowShare(list, 0.8), false);
  list[0].active = true; list[1].active = false;
  assert.equal(belowShare(list, 0.8), true);
});

test('backgroundJobs: limited or no account means no room', () => {
  assert.equal(belowShare([{ active: true, limited: true, usage: usage(1) }], 0.8), false);
  assert.equal(belowShare([], 0.8), false);
});

test('backgroundJobs: the learning loop and cleanup step aside while a training holds the lock', async () => {
  __resetLock();
  const { tick, cleanupOne, isBusy } = await import('./learning');
  const release = tryAcquire('training')!;
  assert.equal(isBusy(), true);
  assert.deepEqual(await tick(), { learned: 0, proposals: 0, waiting: 'een training loopt' });
  assert.deepEqual(await cleanupOne('00000000-0000-0000-0000-000000000000'), { waiting: 'een training loopt' });
  release();
  assert.equal(isBusy(), false);
});
