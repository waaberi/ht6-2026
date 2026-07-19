import assert from 'node:assert/strict';
import test from 'node:test';

import { emptyLayerStack } from './layers';
import { mergeHydratedPhotos, mergeSyncProgress } from './syncMerge';
import type { PhotoRecord } from './types';

const photo = (id: string, versionId = `${id}-v1`, syncState: PhotoRecord['syncState'] = 'synced'): PhotoRecord => ({
  id,
  ownerId: 'account-a',
  createdAt: id === 'new' ? '2026-07-18T12:00:00.000Z' : '2026-07-18T10:00:00.000Z',
  captureSource: 'camera',
  originalUri: `file:///${id}.jpg`,
  originalName: `${id}.jpg`,
  originalMimeType: 'image/jpeg',
  originalByteSize: 1,
  originalChecksum: id,
  analysisProxyUri: `file:///${id}-proxy.jpg`,
  thumbnailUri: `file:///${id}-thumb.jpg`,
  exif: {},
  currentVersionId: versionId,
  versions: [{ id: versionId, photoId: id, createdAt: '2026-07-18T10:00:00.000Z', label: 'Edit', stack: emptyLayerStack() }],
  syncState,
});

test('sync progress preserves photos created after a sync started', () => {
  const result = mergeSyncProgress('account-a', [photo('new', 'new-v1', 'queued'), photo('old')], [photo('old', 'old-v1', 'syncing')]);
  assert.deepEqual(result.map(({ id }) => id), ['new', 'old']);
  assert.equal(result[1].syncState, 'syncing');
});

test('sync progress never overwrites a newer local version', () => {
  const result = mergeSyncProgress('account-a', [photo('old', 'old-v2', 'queued')], [photo('old', 'old-v1', 'synced')]);
  assert.equal(result[0].currentVersionId, 'old-v2');
  assert.equal(result[0].syncState, 'queued');
});

test('cloud hydration adds remote photos without resurrecting deletions', () => {
  const result = mergeHydratedPhotos(
    'account-a',
    [photo('new', 'new-v1', 'queued')],
    [photo('remote'), photo('deleted')],
    ['deleted'],
  );
  assert.deepEqual(result.map(({ id }) => id), ['new', 'remote']);
});

test('sync merging rejects records from another owner', () => {
  assert.throws(
    () => mergeSyncProgress('account-b', [photo('old')], []),
    /different account/,
  );
  assert.throws(
    () => mergeHydratedPhotos('account-b', [], [photo('remote')], []),
    /different account/,
  );
});
