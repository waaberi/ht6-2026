import assert from 'node:assert/strict';
import test from 'node:test';

import { clampZoom, horizonRollForOrientation, zoomFromPinch } from './cameraControls';

test('pinch zoom is monotonic and clamped to the camera range', () => {
  assert.ok(zoomFromPinch(0.2, 100, 160) > 0.2);
  assert.ok(zoomFromPinch(0.6, 100, 60) < 0.6);
  assert.equal(zoomFromPinch(0.95, 100, 10000), 1);
  assert.equal(zoomFromPinch(0.05, 100, 1), 0);
  assert.equal(clampZoom(Number.POSITIVE_INFINITY), 1);
});

test('horizon roll follows the active device orientation', () => {
  const rotation = { beta: 0.2, gamma: -0.35 };
  assert.equal(horizonRollForOrientation(rotation, 0), -0.35);
  assert.equal(horizonRollForOrientation(rotation, 90), 0.2);
  assert.equal(horizonRollForOrientation(rotation, -90), -0.2);
  assert.equal(horizonRollForOrientation(rotation, 180), 0.35);
  assert.equal(horizonRollForOrientation(null, 0), 0);
});
