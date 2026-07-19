import assert from 'node:assert/strict';
import test from 'node:test';

import type { CoachFeedbackPlan } from './coachFeedback';
import { buildCoachNarration } from './coachNarration';
import type { AnalysisResult } from './types';

const analysis = {
  summary: 'The portrait is slightly dark but keeps a quiet mood.',
} as AnalysisResult;

const feedback: CoachFeedbackPlan = {
  adjustments: {},
  items: [
    {
      section: 'light',
      title: 'Lift the subject',
      description: 'Raise exposure gently while protecting the window highlights.',
      adjustments: { exposure: 0.2 },
      changed: true,
    },
    {
      section: 'color',
      title: 'Keep color natural',
      description: 'Use a restrained temperature correction.',
      adjustments: { temperature: 0.05 },
      changed: true,
    },
    {
      section: 'detail',
      title: 'Protect fine detail',
      description: 'Keep sharpening restrained to avoid halos.',
      adjustments: { sharpening: 0.1 },
      changed: true,
    },
    {
      section: 'crop',
      title: 'Keep the framing',
      description: 'The current crop keeps the subject balanced.',
      changed: false,
    },
  ],
};

test('Coach narration speaks the summary and each visible feedback section', () => {
  const narration = buildCoachNarration(analysis, feedback);

  assert.equal(
    narration,
    'Exposure Coach. The portrait is slightly dark but keeps a quiet mood. '
      + 'light. Lift the subject. Raise exposure gently while protecting the window highlights. '
      + 'color. Keep color natural. Use a restrained temperature correction. '
      + 'detail. Protect fine detail. Keep sharpening restrained to avoid halos. '
      + 'crop. Keep the framing. The current crop keeps the subject balanced.',
  );
});

test('Coach narration is bounded to the API contract', () => {
  const verbose: CoachFeedbackPlan = {
    ...feedback,
    items: feedback.items.map((item) => ({
      ...item,
      description: 'detail '.repeat(400),
    })) as CoachFeedbackPlan['items'],
  };

  assert.equal(buildCoachNarration(analysis, verbose).length, 1600);
});
