import assert from 'node:assert/strict';
import test from 'node:test';

import {
  centeredCrop,
  quarterTurnsForRotation,
  resolveCanvasExpansion,
  restoreManualTransform,
  rotateCropClockwise,
  rotateClockwise,
  straightenDegrees,
  visibleCropAspect,
  visibleRotatedCanvasSize,
  withRotationAdjustment,
  withStraighten,
} from './canvasTransforms';
import { identityCanvasTransform, type CanvasTransform } from './types';

test('centered crop preserves the requested landscape or portrait aspect', () => {
  assert.deepEqual(centeredCrop(4000, 3000, 1), { x: 0.125, y: 0, width: 0.75, height: 1 });
  assert.deepEqual(centeredCrop(3000, 4000, 3 / 4), { x: 0, y: 0, width: 1, height: 1 });
});

test('crop presets are normalized against the visible canvas after rotation', () => {
  assert.deepEqual(visibleRotatedCanvasSize(160, 120, 90), { width: 120, height: 160 });
  const crop = centeredCrop(160, 120, 9 / 16, 90);
  assert.deepEqual(crop, {
    x: 0.125,
    y: 0,
    width: 0.75,
    height: 1,
  });
  assert.ok(Math.abs(visibleCropAspect(160, 120, {
    ...identityCanvasTransform(),
    rotationDegrees: 90,
    crop,
  }) - 9 / 16) < 0.0001);
});

test('straightening remains independent from quarter-turn rotation', () => {
  const rotated = rotateClockwise(identityCanvasTransform());
  const straightened = withStraighten(rotated, -4.5);

  assert.equal(straightened.rotationDegrees, 85.5);
  assert.equal(straightenDegrees(straightened.rotationDegrees), -4.5);
});

test('manual rotation supports the normal editor range without losing orientation', () => {
  const rotated = rotateClockwise(identityCanvasTransform());

  assert.equal(withRotationAdjustment(rotated, -37.5).rotationDegrees, 52.5);
  assert.equal(withRotationAdjustment(rotated, 37.5).rotationDegrees, 127.5);
  const clockwiseLimit = withRotationAdjustment(rotated, 90);
  const counterClockwiseLimit = withRotationAdjustment(rotated, -90);
  assert.equal(quarterTurnsForRotation(clockwiseLimit.rotationDegrees), 1);
  assert.equal(quarterTurnsForRotation(counterClockwiseLimit.rotationDegrees), 1);
  assert.ok(Math.abs(straightenDegrees(clockwiseLimit.rotationDegrees) - 45) < 0.0001);
  assert.ok(Math.abs(straightenDegrees(counterClockwiseLimit.rotationDegrees) + 45) < 0.0001);
  assert.equal(quarterTurnsForRotation(45), 0);
  assert.equal(quarterTurnsForRotation(135), 1);
});

test('clockwise rotation maps an existing crop with the visible canvas', () => {
  const crop = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
  assert.deepEqual(rotateCropClockwise(crop), { x: 0.4, y: 0.1, width: 0.4, height: 0.3 });

  let transform: CanvasTransform = { ...identityCanvasTransform(), crop };
  for (let turn = 0; turn < 4; turn += 1) transform = rotateClockwise(transform);
  assert.deepEqual(transform.crop, crop);
});

test('restoring manual geometry keeps generative expansion intact', () => {
  const restored = restoreManualTransform({
    ...identityCanvasTransform(),
    rotationDegrees: 6,
    crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
    expansion: {
      top: 0,
      right: 120,
      bottom: 0,
      left: 0,
      referenceWidth: 1200,
      referenceHeight: 800,
    },
  });

  assert.equal(restored.rotationDegrees, 0);
  assert.equal(restored.crop, undefined);
  assert.deepEqual(restored.expansion, {
    top: 0,
    right: 120,
    bottom: 0,
    left: 0,
    referenceWidth: 1200,
    referenceHeight: 800,
  });
});

test('reference-sized expansion scales with the rendered canvas while legacy pixels remain raw', () => {
  assert.deepEqual(resolveCanvasExpansion({
    top: 300,
    right: 1000,
    bottom: 0,
    left: 200,
    referenceWidth: 4000,
    referenceHeight: 3000,
  }, 1600, 1200), {
    top: 120,
    right: 400,
    bottom: 0,
    left: 80,
  });
  assert.deepEqual(
    resolveCanvasExpansion({ top: 7, right: 11, bottom: 13, left: 17 }, 1600, 1200),
    { top: 7, right: 11, bottom: 13, left: 17 },
  );
});
