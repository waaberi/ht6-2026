import assert from 'node:assert/strict';
import test from 'node:test';

import {
  cropRegionForAspectRatio,
  displayedCropAspect,
  moveCropRegion,
  normalizeCropRegion,
  resizeCropRegion,
} from './cropGeometry';

const closeTo = (actual: number, expected: number, epsilon = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} should equal ${expected}`);
};

test('aspect presets use displayed pixels for landscape and portrait images', () => {
  const landscape = { width: 400, height: 300 };
  const wide = cropRegionForAspectRatio({ x: 0, y: 0, width: 1, height: 1 }, 16 / 9, landscape);
  closeTo(displayedCropAspect(wide, landscape), 16 / 9);
  closeTo(wide.x, 0);
  closeTo(wide.y, 0.125);
  closeTo(wide.width, 1);
  closeTo(wide.height, 0.75);

  const portrait = { width: 300, height: 400 };
  const tall = cropRegionForAspectRatio({ x: 0, y: 0, width: 1, height: 1 }, 9 / 16, portrait);
  closeTo(displayedCropAspect(tall, portrait), 9 / 16);
  closeTo(tall.x, 0.125);
  closeTo(tall.y, 0);
  closeTo(tall.width, 0.75);
  closeTo(tall.height, 1);
});

test('locked corner resizing preserves its physical output ratio', () => {
  const viewport = { width: 300, height: 500 };
  const source = cropRegionForAspectRatio({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, 4 / 3, viewport);
  const resized = resizeCropRegion(source, 'bottom-right', { dx: -47, dy: -18 }, viewport, 0.12, 4 / 3);

  closeTo(displayedCropAspect(resized, viewport), 4 / 3);
  closeTo(resized.x, source.x);
  closeTo(resized.y, source.y);
  assert.ok(resized.x + resized.width <= 1);
  assert.ok(resized.y + resized.height <= 1);
});

test('locked resizing stays in bounds at every corner', () => {
  const viewport = { width: 480, height: 320 };
  const source = cropRegionForAspectRatio({ x: 0.2, y: 0.15, width: 0.6, height: 0.7 }, 1, viewport);
  const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const;

  for (const corner of corners) {
    const resized = resizeCropRegion(source, corner, { dx: 900, dy: -900 }, viewport, 0.12, 1);
    closeTo(displayedCropAspect(resized, viewport), 1);
    assert.ok(resized.x >= 0 && resized.y >= 0);
    assert.ok(resized.x + resized.width <= 1 + 1e-9);
    assert.ok(resized.y + resized.height <= 1 + 1e-9);
  }
});

test('freeform move and resize remain bounded and respect the minimum', () => {
  const viewport = { width: 400, height: 300 };
  const source = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
  assert.deepEqual(moveCropRegion(source, { dx: 1000, dy: -1000 }, viewport), {
    x: 0.5,
    y: 0,
    width: 0.5,
    height: 0.5,
  });

  const resized = resizeCropRegion(source, 'top-left', { dx: 1000, dy: 1000 }, viewport, 0.12);
  closeTo(resized.width, 0.12);
  closeTo(resized.height, 0.12);
  assert.deepEqual(normalizeCropRegion(resized), resized);
});
