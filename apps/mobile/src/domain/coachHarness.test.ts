import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCoachAdjustmentTargets,
  buildCoachEditPreview,
  isCoachEditPreviewCurrent,
  isPreviewableCoachActionPlan,
  planCoachAction,
} from './coachHarness';
import { collectiveAdjustmentValues, emptyLayerStack, setCollectiveAdjustments } from './layers';
import { identityCanvasTransform, type CoachAction } from './types';

const action = (changes: Partial<CoachAction> & Pick<CoachAction, 'tool'>): CoachAction => ({
  id: changes.tool,
  label: changes.tool,
  reason: 'Fixture reason',
  basedOn: ['metrics.meanLuminance'],
  requiresConfirmation: true,
  ...changes,
});

test('every Coach tool routes into a concrete editor or camera plan', () => {
  const transform = identityCanvasTransform();
  assert.equal(planCoachAction(action({ tool: 'adjust_global', adjustments: { exposure: 0.2 } }), transform).kind, 'collective-adjustment');
  assert.equal(planCoachAction(action({ tool: 'adjust_masked', adjustments: { shadows: 0.2 }, target: { x: 0, y: 0, width: 0.5, height: 0.5 } }), transform).kind, 'masked-adjustment');
  assert.equal(planCoachAction(action({ tool: 'crop', canvasTransform: { crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 } } }), transform).kind, 'canvas-transform');
  assert.equal(planCoachAction(action({ tool: 'straighten', canvasTransform: { rotationDegrees: 3 } }), transform).kind, 'canvas-transform');
  assert.equal(planCoachAction(action({ tool: 'remove', target: { x: 0, y: 0, width: 0.2, height: 0.2 } }), transform).kind, 'generative');
  assert.equal(planCoachAction(action({ tool: 'add', target: { x: 0, y: 0, width: 0.2, height: 0.2 }, prompt: 'Add a kite' }), transform).kind, 'generative');
  assert.deepEqual(planCoachAction(action({ tool: 'expand', expansionFraction: 0.35, canvasTransform: { expansion: { top: 0, right: 1, bottom: 0, left: 0 } } }), transform), {
    kind: 'expand', direction: 'right', fraction: 0.35, prompt: 'Extend the scene naturally into the new canvas.',
  });
  assert.equal(planCoachAction(action({ tool: 'retake' }), transform).kind, 'camera');
});

test('incomplete AI actions fail instead of silently doing the wrong edit', () => {
  assert.throws(() => planCoachAction(action({ tool: 'adjust_masked', adjustments: { exposure: 0.2 } }), identityCanvasTransform()), /incomplete/);
  assert.throws(() => planCoachAction(action({ tool: 'expand' }), identityCanvasTransform()), /incomplete/);
  assert.throws(() => planCoachAction(action({ tool: 'expand', expansionFraction: 0.8, canvasTransform: { expansion: { top: 1, right: 0, bottom: 0, left: 0 } } }), identityCanvasTransform()), /incomplete/);
});

test('Coach global adjustments target the same absolute controls as manual edits', () => {
  const current = setCollectiveAdjustments(emptyLayerStack(), { exposure: 0.2, contrast: -0.1 });
  const next = applyCoachAdjustmentTargets(current, { exposure: 0.3 });
  assert.deepEqual(collectiveAdjustmentValues(next), { exposure: 0.3, contrast: -0.1 });
});

test('Coach global preview uses manual collective values without mutating the current stack', () => {
  const current = setCollectiveAdjustments(emptyLayerStack(), { exposure: 0.2, contrast: -0.1 });
  const plan = planCoachAction(action({ tool: 'adjust_global', adjustments: { exposure: 0.35 } }), current.canvasTransform);
  assert.equal(isPreviewableCoachActionPlan(plan), true);
  if (!isPreviewableCoachActionPlan(plan)) return;

  const preview = buildCoachEditPreview(current, plan, { id: 'unused', name: 'Exposure', createdAt: 'now' });

  assert.equal(preview.kind, 'collective-adjustment');
  assert.deepEqual(preview.stack.adjustments, { exposure: 0.35, contrast: -0.1 });
  assert.deepEqual(current.adjustments, { exposure: 0.2, contrast: -0.1 });
});

test('Coach masked preview appends one reversible layer without changing the source stack', () => {
  const current = emptyLayerStack();
  const target = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
  const plan = planCoachAction(action({ tool: 'adjust_masked', adjustments: { shadows: 0.25 }, target }), current.canvasTransform);
  if (!isPreviewableCoachActionPlan(plan)) throw new Error('Expected a previewable plan');

  const preview = buildCoachEditPreview(current, plan, { id: 'mask', name: 'Lift subject', createdAt: 'now' });

  assert.equal(current.layers.length, 0);
  assert.deepEqual(preview.stack.layers, [{
    id: 'mask',
    type: 'masked-adjustment',
    name: 'Lift subject',
    enabled: true,
    opacity: 1,
    createdAt: 'now',
    adjustments: { shadows: 0.25 },
    mask: { type: 'polygon', region: target },
  }]);
});

test('Coach crop and straighten previews use the exact manual canvas-transform stack shape', () => {
  const current = emptyLayerStack();
  current.adjustments = { exposure: 0.15 };
  const cropPlan = planCoachAction(action({
    tool: 'crop',
    canvasTransform: { crop: { x: 0.1, y: 0.15, width: 0.8, height: 0.7 } },
  }), current.canvasTransform);
  const straightenPlan = planCoachAction(action({
    tool: 'straighten',
    canvasTransform: { rotationDegrees: 2.5 },
  }), current.canvasTransform);
  if (!isPreviewableCoachActionPlan(cropPlan) || !isPreviewableCoachActionPlan(straightenPlan)) {
    throw new Error('Expected previewable transform plans');
  }

  const crop = buildCoachEditPreview(current, cropPlan, { id: 'unused', name: 'Crop', createdAt: 'now' });
  const straighten = buildCoachEditPreview(current, straightenPlan, { id: 'unused', name: 'Straighten', createdAt: 'now' });

  assert.deepEqual(crop.stack, {
    ...current,
    canvasTransform: { ...current.canvasTransform, crop: { x: 0.1, y: 0.15, width: 0.8, height: 0.7 } },
  });
  assert.deepEqual(straighten.stack, {
    ...current,
    canvasTransform: { ...current.canvasTransform, rotationDegrees: 2.5 },
  });
  assert.deepEqual(current.canvasTransform, identityCanvasTransform());
});

test('Coach edit previews are current only for their captured photo version', () => {
  const source = { sourcePhotoId: 'photo', sourceVersionId: 'version-1' };

  assert.equal(isCoachEditPreviewCurrent(source, 'photo', 'version-1'), true);
  assert.equal(isCoachEditPreviewCurrent(source, 'photo', 'version-2'), false);
  assert.equal(isCoachEditPreviewCurrent(source, 'other-photo', 'version-1'), false);
  assert.equal(isCoachEditPreviewCurrent(source, undefined, undefined), false);
});
