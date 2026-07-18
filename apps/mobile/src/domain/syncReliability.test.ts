import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chunkValues,
  collectPages,
  fulfilledValues,
  groupValuesBy,
  mapSettledWithConcurrency,
  pageBounds,
  retryBestEffort,
} from './syncReliability';

test('page bounds use inclusive ranges without gaps', () => {
  assert.deepEqual(pageBounds(0, 500), { from: 0, to: 499 });
  assert.deepEqual(pageBounds(1, 500), { from: 500, to: 999 });
  assert.throws(() => pageBounds(-1, 500), /Page index/);
  assert.throws(() => pageBounds(0, 0), /Page size/);
});

test('large filters are split into bounded batches', () => {
  assert.deepEqual(chunkValues([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunkValues([], 2), []);
  assert.throws(() => chunkValues([1], 0), /Chunk size/);
});

test('page collection continues past full pages and preserves range order', async () => {
  const ranges: Array<[number, number]> = [];
  const values = await collectPages(2, async (from, to) => {
    ranges.push([from, to]);
    return from < 4 ? [from, from + 1] : [from];
  });
  assert.deepEqual(ranges, [[0, 1], [2, 3], [4, 5]]);
  assert.deepEqual(values, [0, 1, 2, 3, 4]);
});

test('rows are grouped once for per-photo hydration', () => {
  const grouped = groupValuesBy([
    { photoId: 'a', id: 1 },
    { photoId: 'b', id: 2 },
    { photoId: 'a', id: 3 },
  ], (row) => row.photoId);
  assert.deepEqual(grouped.get('a')?.map((row) => row.id), [1, 3]);
  assert.deepEqual(grouped.get('b')?.map((row) => row.id), [2]);
});

test('settled hydration preserves successful photos when one object fails', async () => {
  let active = 0;
  let maxActive = 0;
  const results = await mapSettledWithConcurrency(['first', 'bad', 'last'], 2, async (value) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    active -= 1;
    if (value === 'bad') throw new Error('download failed');
    return value.toUpperCase();
  });

  assert.deepEqual(fulfilledValues(results), ['FIRST', 'LAST']);
  assert.equal(results[1].status, 'rejected');
  assert.ok(maxActive <= 2);
});

test('best-effort cleanup retries transient errors without throwing', async () => {
  let attempts = 0;
  assert.equal(await retryBestEffort(3, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('offline');
    return attempts === 3;
  }), true);
  assert.equal(attempts, 3);
  assert.equal(await retryBestEffort(2, async () => false), false);
});
