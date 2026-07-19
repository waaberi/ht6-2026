import assert from 'node:assert/strict';
import test from 'node:test';

import { adjustmentPreviewMatrix, globalPreviewAdjustments } from './adjustmentPreview';
import { emptyLayerStack } from './layers';

test('the Original Look preview uses an identity color matrix', () => {
  assert.deepEqual(adjustmentPreviewMatrix({}), [
    1, 0, 0, 0, 0,
    0, 1, 0, 0, 0,
    0, 0, 1, 0, 0,
    0, 0, 0, 1, 0,
  ]);
});

test('Look thumbnails fold the same enabled style strength used by the editor', () => {
  const stack = emptyLayerStack();
  stack.adjustments = { exposure: 0.1 };
  stack.layers.push({
    id: 'look',
    type: 'style',
    name: 'Vibrant',
    enabled: true,
    opacity: 0.5,
    createdAt: '2026-01-01T00:00:00.000Z',
    styleProfileId: 'vibrant',
    adjustments: { exposure: 0.2, vibrance: 0.4 },
    strength: 0.75,
  });

  const adjustments = globalPreviewAdjustments(stack);
  assert.ok(Math.abs((adjustments.exposure ?? 0) - 0.175) < 0.0001);
  assert.ok(Math.abs((adjustments.vibrance ?? 0) - 0.15) < 0.0001);
});
