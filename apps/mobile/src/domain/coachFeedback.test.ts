import assert from 'node:assert/strict';
import test from 'node:test';

import { applyCoachFeedback, buildCoachFeedback } from './coachFeedback';
import { emptyLayerStack } from './layers';
import { identityCanvasTransform, type AnalysisResult } from './types';

const analysisFixture = (): AnalysisResult => ({
  versionId: 'version',
  checksum: 'checksum',
  createdAt: '2026-01-01T00:00:00.000Z',
  deterministicModel: 'fixture',
  metrics: {
    meanLuminance: 0.24,
    contrastStd: 0.09,
    meanSaturation: 0.08,
    sharpnessLaplacianVariance: 0.0006,
    estimatedNoise: 0.05,
  },
  lighting: {
    exposure: -0.26,
    contrast: 0.09,
    clippedShadows: 0.12,
    clippedHighlights: 0.02,
    colorCast: { red: 0.05, green: -0.01, blue: -0.04 },
  },
  signals: [{
    id: 'border',
    signalKey: 'composition.border-saliency-outlier',
    category: 'distraction',
    evidence: { borderOutlierRatio: 2 },
    severity: 0.7,
    confidence: 0.7,
    location: { x: 0, y: 0.35, width: 0.12, height: 0.2 },
    fix: { kind: 'retouch' },
  }],
  issues: [],
  cameraRecommendations: [],
  summary: 'Fixture',
});

test('Coach feedback always returns Light, Color, Detail, and Crop in order', () => {
  const feedback = buildCoachFeedback(analysisFixture(), {}, identityCanvasTransform());

  assert.equal(feedback.items.length, 4);
  assert.deepEqual(feedback.items.map((item) => item.section), ['light', 'color', 'detail', 'crop']);
  assert.deepEqual(Object.keys(feedback.items[0].adjustments ?? {}), ['exposure', 'contrast', 'highlights', 'shadows']);
  assert.deepEqual(Object.keys(feedback.items[1].adjustments ?? {}), ['temperature', 'tint', 'saturation', 'vibrance']);
  assert.deepEqual(Object.keys(feedback.items[2].adjustments ?? {}), ['sharpening', 'denoise']);
  assert.ok((feedback.items[3].crop?.x ?? 0) > 0);
});

test('accepting Coach feedback replaces manual tweaks and preserves non-adjustment layers', () => {
  const stack = emptyLayerStack();
  stack.adjustments = { exposure: -0.8, grain: 0.7, vignette: 0.5 };
  stack.layers.push({
    id: 'mask',
    type: 'masked-adjustment',
    name: 'Face',
    enabled: true,
    opacity: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    adjustments: { exposure: 0.2 },
    mask: { type: 'subject' },
  });
  const feedback = buildCoachFeedback(analysisFixture(), stack.adjustments, stack.canvasTransform);
  const applied = applyCoachFeedback(stack, feedback);

  assert.deepEqual(applied.adjustments, feedback.adjustments);
  assert.equal(applied.adjustments?.grain, undefined);
  assert.equal(applied.adjustments?.vignette, undefined);
  assert.equal(applied.layers.length, 1);
  assert.deepEqual(applied.canvasTransform.crop, feedback.crop);
  assert.deepEqual(stack.adjustments, { exposure: -0.8, grain: 0.7, vignette: 0.5 });
});

test('balanced photos still receive four feedback items without inventing a crop', () => {
  const analysis = analysisFixture();
  analysis.metrics = {
    ...analysis.metrics,
    meanLuminance: 0.52,
    contrastStd: 0.2,
    meanSaturation: 0.35,
    sharpnessLaplacianVariance: 0.004,
    estimatedNoise: 0.01,
  };
  analysis.lighting = {
    exposure: 0.02,
    contrast: 0.2,
    clippedShadows: 0,
    clippedHighlights: 0,
    colorCast: { red: 0, green: 0, blue: 0 },
  };
  analysis.signals = [];

  const feedback = buildCoachFeedback(analysis, {}, identityCanvasTransform());

  assert.equal(feedback.items.length, 4);
  assert.equal(feedback.items[3].changed, false);
  assert.equal(feedback.crop, undefined);
});
