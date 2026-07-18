import assert from 'node:assert/strict';
import test from 'node:test';

import { centeredCrop, restoreManualTransform, rotateClockwise, straightenDegrees, withStraighten } from './canvasTransforms';
import { identityCanvasTransform } from './types';

test('centered crop preserves the requested landscape or portrait aspect', () => {
  assert.deepEqual(centeredCrop(4000, 3000, 1), { x: 0.125, y: 0, width: 0.75, height: 1 });
  const portrait = centeredCrop(3000, 4000, 4 / 3);
  assert.equal(portrait.x, 0);
  assert.ok(Math.abs(portrait.height - 1) < 0.0001);
});

test('straightening remains independent from quarter-turn rotation', () => {
  const rotated = rotateClockwise(identityCanvasTransform());
  const straightened = withStraighten(rotated, -4.5);

  assert.equal(straightened.rotationDegrees, 85.5);
  assert.equal(straightenDegrees(straightened.rotationDegrees), -4.5);
});

test('restoring manual geometry keeps generative expansion intact', () => {
  const restored = restoreManualTransform({
    ...identityCanvasTransform(),
    rotationDegrees: 6,
    crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    expansion: { top: 0, right: 120, bottom: 0, left: 0 },
  });

  assert.equal(restored.rotationDegrees, 0);
  assert.equal(restored.crop, undefined);
  assert.deepEqual(restored.expansion, { top: 0, right: 120, bottom: 0, left: 0 });
});
