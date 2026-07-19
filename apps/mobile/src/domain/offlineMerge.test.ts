import assert from 'node:assert/strict';
import test from 'node:test';

import { emptyLayerStack } from './layers';
import {
  claimGuestPhotos,
  claimableGuestPhotos,
  mergeOfflinePhotos,
} from './offlineMerge';
import type { PhotoRecord } from './types';

const photo = (
  id: string,
  ownerId: string,
  versionId = `${id}-v1`,
  versionCreatedAt = '2026-07-19T10:00:00.000Z',
  syncState: PhotoRecord['syncState'] = 'synced',
): PhotoRecord => ({
  id,
  ownerId,
  createdAt: versionCreatedAt,
  captureSource: 'camera',
  originalUri: `file:///${ownerId}/${id}.jpg`,
  originalName: `${id}.jpg`,
  originalMimeType: 'image/jpeg',
  originalByteSize: 1,
  originalChecksum: id,
  analysisProxyUri: `file:///${ownerId}/${id}-proxy.jpg`,
  thumbnailUri: `file:///${ownerId}/${id}-thumb.jpg`,
  exif: {},
  currentVersionId: versionId,
  versions: [{
    id: versionId,
    photoId: id,
    createdAt: versionCreatedAt,
    label: 'Edit',
    stack: emptyLayerStack(),
  }],
  syncState,
});

test('unclaimed guest photos are offered to the first account without removing guest data', () => {
  const guest = [photo('offline', 'guest', 'offline-v1', undefined, 'queued')];
  const claimable = claimableGuestPhotos(guest, {}, 'account-a');
  const claims = claimGuestPhotos({}, claimable.map(({ id }) => id), 'account-a');

  assert.deepEqual(claimable, guest);
  assert.deepEqual(guest.map(({ ownerId }) => ownerId), ['guest']);
  assert.deepEqual(claims, { offline: 'account-a' });
});

test('claimed guest photos can return to their account but cannot leak into another account', () => {
  const guest = [photo('offline', 'guest')];
  const claims = { offline: 'account-a' };

  assert.equal(claimableGuestPhotos(guest, claims, 'account-a', [], ['offline']).length, 1);
  assert.equal(claimableGuestPhotos(guest, claims, 'account-b', [], ['offline']).length, 0);
});

test('account deletion tombstones prevent an offline copy from being resurrected', () => {
  const guest = [photo('deleted', 'guest')];
  assert.equal(claimableGuestPhotos(guest, {}, 'account-a', ['deleted']).length, 0);
});

test('a retained guest copy stays logged out after its account copy was deleted', () => {
  const guest = [photo('deleted', 'guest')];
  assert.equal(claimableGuestPhotos(guest, { deleted: 'account-a' }, 'account-a').length, 0);
});

test('offline copies join the account library and remain queued for cloud upload', () => {
  const result = mergeOfflinePhotos(
    'account-a',
    [photo('cloud', 'account-a')],
    [photo('offline', 'account-a', 'offline-v1', '2026-07-19T12:00:00.000Z', 'queued')],
  );

  assert.deepEqual(result.map(({ id }) => id), ['offline', 'cloud']);
  assert.equal(result[0].syncState, 'queued');
});

test('later offline edits merge without overwriting newer account history', () => {
  const account = photo('shared', 'account-a', 'account-v2', '2026-07-19T12:00:00.000Z');
  account.versions.unshift({
    id: 'shared-v1',
    photoId: 'shared',
    createdAt: '2026-07-19T10:00:00.000Z',
    label: 'Original',
    stack: emptyLayerStack(),
  });
  const offline = photo('shared', 'account-a', 'offline-v2', '2026-07-19T11:00:00.000Z', 'queued');
  offline.versions.unshift(account.versions[0]);

  const [merged] = mergeOfflinePhotos('account-a', [account], [offline]);
  assert.equal(merged.currentVersionId, 'account-v2');
  assert.deepEqual(merged.versions.map(({ id }) => id), ['shared-v1', 'offline-v2', 'account-v2']);
  assert.equal(merged.syncState, 'queued');
});

test('a newer offline edit becomes current and existing account data is retained', () => {
  const account = photo('shared', 'account-a', 'account-v1', '2026-07-19T10:00:00.000Z');
  const offline = photo('shared', 'account-a', 'offline-v2', '2026-07-19T12:00:00.000Z', 'queued');
  offline.versions.unshift(account.versions[0]);

  const [merged] = mergeOfflinePhotos('account-a', [account], [offline]);
  assert.equal(merged.currentVersionId, 'offline-v2');
  assert.equal(merged.syncState, 'queued');
  assert.deepEqual(merged.versions.map(({ id }) => id), ['account-v1', 'offline-v2']);
});

test('repeating an import with identical history leaves the synced account record unchanged', () => {
  const account = photo('shared', 'account-a');
  const offline = { ...account, syncState: 'queued' as const };
  const [merged] = mergeOfflinePhotos('account-a', [account], [offline]);

  assert.equal(merged, account);
  assert.equal(merged.syncState, 'synced');
});
