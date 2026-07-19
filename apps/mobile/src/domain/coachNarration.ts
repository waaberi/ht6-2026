import type { CoachFeedbackPlan } from './coachFeedback';
import type { AnalysisResult } from './types';

const MAX_NARRATION_CHARACTERS = 1600;

export const buildCoachNarration = (
  analysis: AnalysisResult,
  feedback: CoachFeedbackPlan,
) => [
  'Exposure Coach.',
  analysis.summary,
  ...feedback.items.flatMap((item) => [
    `${item.section}. ${item.title}.`,
    item.description,
  ]),
]
  .join(' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, MAX_NARRATION_CHARACTERS);
