import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCurrentVersion,
  collectiveAdjustmentValues,
  commitVersion,
  emptyLayerStack,
  makeAdjustmentLayer,
  mergeCollectiveAdjustments,
  restoreVersion,
  setCollectiveAdjustments,
  setLayerOpacity,
  StalePhotoVersionError,
} from './layers';
import type { PhotoRecord } from './types';

const photoFixture = (): PhotoRecord => ({
  id: 'photo',
  createdAt: '2026-01-01T00:00:00.000Z',
  captureSource: 'camera',
  originalUri: 'file:///original.jpg',
  originalName: 'original.jpg',
  originalMimeType: 'image/jpeg',
  originalByteSize: 10,
  originalChecksum: 'checksum',
  analysisProxyUri: 'file:///proxy.jpg',
  thumbnailUri: 'file:///thumb.jpg',
  exif: {},
  currentVersionId: 'original',
  versions: [
    {
      id: 'original',
      photoId: 'photo',
      createdAt: '2026-01-01T00:00:00.000Z',
      label: 'Original',
      stack: emptyLayerStack(),
    },
  ],
  syncState: 'local',
});

test('commits immutable snapshots without changing the original metadata', () => {
  const photo = photoFixture();
  const stack = emptyLayerStack();
  stack.layers.push(makeAdjustmentLayer('exposure', { exposure: 0.4 }));
  const edited = commitVersion(photo, 'edit', stack, 'Exposure');
  stack.layers.length = 0;

  assert.equal(edited.originalChecksum, photo.originalChecksum);
  assert.equal(edited.versions[1].stack.layers.length, 1);
  assert.equal(photo.versions.length, 1);
});

test('restoring history creates a new current version and keeps intervening history', () => {
  const photo = photoFixture();
  const edited = commitVersion(photo, 'edit', emptyLayerStack(), 'Edit');
  const restored = restoreVersion(edited, 'original', 'restore');

  assert.equal(restored.versions.length, 3);
  assert.equal(restored.currentVersionId, 'restore');
  assert.equal(restored.versions[2].restoredFromVersionId, 'original');
  assert.equal(restored.versions[2].parentVersionId, 'edit');
});

test('delayed edits cannot commit against a stale photo version', () => {
  const original = photoFixture();
  const edited = commitVersion(original, 'manual-edit', emptyLayerStack(), 'Manual edit');

  assert.equal(assertCurrentVersion(edited, 'manual-edit').id, 'manual-edit');
  assert.throws(
    () => assertCurrentVersion(edited, 'original'),
    (error) => error instanceof StalePhotoVersionError,
  );
});

test('collective adjustments fold legacy global layers without touching advanced layers', () => {
  const stack = emptyLayerStack();
  stack.adjustments = { exposure: 0.2 };
  stack.layers.push(makeAdjustmentLayer('legacy', { exposure: 0.15, contrast: 0.3 }));
  stack.layers.push({
    id: 'masked',
    type: 'masked-adjustment',
    name: 'Face',
    enabled: true,
    opacity: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    adjustments: { exposure: 0.1 },
    mask: { type: 'subject' },
  });

  assert.deepEqual(collectiveAdjustmentValues(stack), { exposure: 0.35, contrast: 0.3 });
  const consolidated = setCollectiveAdjustments(stack, { exposure: 0.4 });
  assert.deepEqual(consolidated.adjustments, { exposure: 0.4 });
  assert.deepEqual(consolidated.layers.map((layer) => layer.id), ['masked']);
});

test('collective edits stay on one photo stack and do not become defaults', () => {
  const original = emptyLayerStack();
  const edited = mergeCollectiveAdjustments(original, { exposure: 0.25 });
  const revised = mergeCollectiveAdjustments(edited, { exposure: -0.1, saturation: 0.2 });

  assert.deepEqual(original.adjustments, {});
  assert.deepEqual(revised.adjustments, { exposure: 0.15, saturation: 0.2 });
  assert.deepEqual(emptyLayerStack().adjustments, {});
  assert.equal(revised.layers.length, 0);
});

test('layer opacity is immutable and clamped to the supported range', () => {
  const stack = emptyLayerStack();
  stack.layers.push(makeAdjustmentLayer('adjustment', { exposure: 0.3 }));

  const faded = setLayerOpacity(stack, 'adjustment', 0.35);
  const clamped = setLayerOpacity(faded, 'adjustment', 2);

  assert.equal(stack.layers[0].opacity, 1);
  assert.equal(faded.layers[0].opacity, 0.35);
  assert.equal(clamped.layers[0].opacity, 1);
});
