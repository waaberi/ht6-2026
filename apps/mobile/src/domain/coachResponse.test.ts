import assert from 'node:assert/strict';
import test from 'node:test';

import { InvalidCoachResponseError, parseCoachResponse } from './coachResponse';

const response = (action: Record<string, unknown>) => ({
  headline: 'Protect the highlights',
  reason: 'The brightest area is close to clipping.',
  evidence: [{ path: 'lighting.clippedHighlights', value: 0.08, meaning: 'A small highlight area is near the limit.' }],
  captureAdvice: [{ setting: 'iso', value: 'ISO 100', tradeoff: 'May require a slower shutter.', basedOn: ['lighting.clippedHighlights'] }],
  actions: [{
    id: 'action-1',
    label: 'Apply',
    reason: 'Preserve highlight detail.',
    basedOn: ['lighting.clippedHighlights'],
    requiresConfirmation: true,
    adjustments: null,
    target: null,
    prompt: null,
    canvasTransform: null,
    expansionFraction: null,
    ...action,
  }],
  model: 'gemini-coach',
});

test('parses a valid response and preserves a bounded expand fraction', () => {
  const parsed = parseCoachResponse(response({
    tool: 'expand',
    prompt: 'Continue the sky naturally.',
    canvasTransform: { expansion: { top: 0, right: 1, bottom: 0, left: 0 } },
    expansionFraction: 0.3,
  }));

  assert.equal(parsed.evidence[0]?.value, 0.08);
  assert.deepEqual(parsed.actions[0], {
    id: 'action-1',
    tool: 'expand',
    label: 'Apply',
    reason: 'Preserve highlight detail.',
    basedOn: ['lighting.clippedHighlights'],
    requiresConfirmation: true,
    prompt: 'Continue the sky naturally.',
    canvasTransform: { expansion: { top: 0, right: 1, bottom: 0, left: 0 } },
    expansionFraction: 0.3,
  });
});

test('rejects unknown fields, tools, and non-confirmable actions', () => {
  assert.throws(
    () => parseCoachResponse({ ...response({ tool: 'retake' }), commentary: 'ignore validation' }),
    InvalidCoachResponseError,
  );
  assert.throws(() => parseCoachResponse(response({ tool: 'auto_magic' })), /supported Coach tool/);
  assert.throws(() => parseCoachResponse(response({ tool: 'retake', requiresConfirmation: false })), /must be true/);
  assert.throws(() => parseCoachResponse(response({ tool: 'retake', basedOn: [] })), /basedOn.*at least one/);
});

test('rejects unsupported, non-finite, and out-of-range adjustments', () => {
  assert.throws(() => parseCoachResponse(response({ tool: 'adjust_global', adjustments: { clarity: 0.2 } })), /not supported/);
  assert.throws(() => parseCoachResponse(response({ tool: 'adjust_global', adjustments: { exposure: Number.NaN } })), /finite number/);
  assert.throws(() => parseCoachResponse(response({ tool: 'adjust_global', adjustments: { exposure: 1.1 } })), /between -1 and 1/);
});

test('rejects regions outside normalized image bounds', () => {
  assert.throws(
    () => parseCoachResponse(response({ tool: 'amplify', prompt: 'Remove the wire', target: { x: 0.8, y: 0, width: 0.3, height: 0.4 } })),
    /inside normalized image bounds/,
  );
  assert.throws(
    () => parseCoachResponse(response({ tool: 'amplify', prompt: 'Remove the wire', target: { x: 0, y: 0, width: 0, height: 0.4 } })),
    /greater than 0/,
  );
});

test('enforces tool-specific target, prompt, crop, and rotation contracts', () => {
  assert.throws(() => parseCoachResponse(response({ tool: 'adjust_masked', adjustments: { shadows: 0.2 } })), /target.*required/);
  assert.throws(() => parseCoachResponse(response({ tool: 'amplify', target: { x: 0, y: 0, width: 0.2, height: 0.2 } })), /prompt.*required/);
  assert.throws(() => parseCoachResponse(response({ tool: 'crop', canvasTransform: { rotationDegrees: 2 } })), /crop.*required/);
  assert.throws(() => parseCoachResponse(response({ tool: 'straighten', canvasTransform: { rotationDegrees: 46 } })), /between -45 and 45/);
  assert.throws(() => parseCoachResponse(response({ tool: 'retake', canvasTransform: { rotationDegrees: 2 } })), /not valid for retake/);
});

test('requires one expansion edge and a fraction from 0.1 to 0.5', () => {
  assert.throws(
    () => parseCoachResponse(response({ tool: 'expand', canvasTransform: { expansion: { top: 0, right: 1, bottom: 0, left: 0 } } })),
    /expansionFraction.*required/,
  );
  assert.throws(
    () => parseCoachResponse(response({ tool: 'expand', canvasTransform: { expansion: { top: 0, right: 1, bottom: 0, left: 0 } }, expansionFraction: 0.51 })),
    /between 0.1 and 0.5/,
  );
  assert.throws(
    () => parseCoachResponse(response({ tool: 'expand', canvasTransform: { expansion: { top: 0, right: 1, bottom: 0, left: 1 } }, expansionFraction: 0.25 })),
    /exactly one positive edge/,
  );
  assert.throws(
    () => parseCoachResponse(response({ tool: 'amplify', prompt: 'Remove the wire', target: { x: 0, y: 0, width: 0.2, height: 0.2 }, expansionFraction: 0.25 })),
    /only valid for expand/,
  );
});

test('requires the complete top-level response shape', () => {
  const missingActions = response({ tool: 'retake' }) as Record<string, unknown>;
  delete missingActions.actions;
  assert.throws(() => parseCoachResponse(missingActions), /response.actions must be an array/);
  assert.throws(() => parseCoachResponse([]), /response must be an object/);
});

test('requires concrete camera advice with a retake action', () => {
  const withoutAdvice = { ...response({ tool: 'retake' }), captureAdvice: [] };
  assert.throws(() => parseCoachResponse(withoutAdvice), /captureAdvice.*accompany/);
  const ungroundedAdvice = {
    ...response({ tool: 'retake' }),
    captureAdvice: [{ setting: 'iso', value: 'ISO 100', tradeoff: 'May require a slower shutter.', basedOn: [] }],
  };
  assert.throws(() => parseCoachResponse(ungroundedAdvice), /captureAdvice\[0\].basedOn.*at least one/);
});

test('rejects verbose Coach copy at the runtime boundary', () => {
  assert.throws(
    () => parseCoachResponse({
      ...response({ tool: 'retake' }),
      headline: 'This headline contains far too many words for one clear mobile recommendation today',
    }),
    /headline.*at most 8 words/,
  );
  assert.throws(
    () => parseCoachResponse(response({
      tool: 'retake',
      label: 'This action label is much too long',
    })),
    /label.*at most 6 words/,
  );
});
