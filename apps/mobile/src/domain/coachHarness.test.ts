import assert from 'node:assert/strict';
import test from 'node:test';

import { applyCoachAdjustmentTargets, planCoachAction } from './coachHarness';
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
