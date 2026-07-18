import assert from 'node:assert/strict';
import test from 'node:test';

import { captureControlsForSession, clampZoom, horizonRollForOrientation, normalizeFlashMode, zoomFromPinch } from './cameraControls';

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

test('unknown or stale flash values fail closed', () => {
  assert.equal(normalizeFlashMode('on'), 'on');
  assert.equal(normalizeFlashMode('auto'), 'auto');
  assert.equal(normalizeFlashMode('off'), 'off');
  assert.equal(normalizeFlashMode('torch'), 'off');
  assert.equal(normalizeFlashMode(undefined), 'off');
});

test('non-preserved capture controls cannot return on the next camera session', () => {
  const defaults = {
    defaultFlash: 'off' as const,
    timerSeconds: 0 as const,
    photoRatio: '4:3' as const,
    zoom: 0,
    preserveCaptureSettings: false,
  };
  assert.deepEqual(captureControlsForSession({
    defaultFlash: 'on',
    timerSeconds: 10,
    photoRatio: '16:9',
    zoom: 0.8,
    preserveCaptureSettings: false,
  }, defaults), defaults);
  assert.deepEqual(captureControlsForSession({
    defaultFlash: 'auto',
    timerSeconds: 3,
    photoRatio: '16:9',
    zoom: 0.4,
    preserveCaptureSettings: true,
  }, defaults), {
    defaultFlash: 'auto',
    timerSeconds: 3,
    photoRatio: '16:9',
    zoom: 0.4,
    preserveCaptureSettings: true,
  });
});
