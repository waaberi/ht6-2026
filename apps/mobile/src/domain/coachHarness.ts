import { appendLayer, collectiveAdjustmentValues, setCollectiveAdjustments } from './layers';
import type { AdjustmentValues, CanvasTransform, CoachAction, LayerStack, Region } from './types';

export type CoachActionPlan =
  | { kind: 'collective-adjustment'; adjustments: AdjustmentValues }
  | { kind: 'masked-adjustment'; adjustments: AdjustmentValues; target: Region }
  | { kind: 'canvas-transform'; transform: CanvasTransform }
  | { kind: 'generative'; target: Region; prompt: string }
  | { kind: 'expand'; direction: 'top' | 'right' | 'bottom' | 'left'; fraction: number; prompt: string }
  | { kind: 'camera' };

export type PreviewableCoachActionPlan = Extract<
  CoachActionPlan,
  { kind: 'collective-adjustment' | 'masked-adjustment' | 'canvas-transform' }
>;

export type CoachEditPreview = {
  kind: PreviewableCoachActionPlan['kind'];
  stack: LayerStack;
};

export type CoachEditSource = {
  sourcePhotoId: string;
  sourceVersionId: string;
};

const incomplete = (tool: CoachAction['tool']): never => {
  throw new Error(`Coach returned an incomplete ${tool} action.`);
};

/** Coach adjustment values are absolute manual-control targets, not deltas. */
export const applyCoachAdjustmentTargets = (
  stack: LayerStack,
  targets: AdjustmentValues,
): LayerStack => setCollectiveAdjustments(stack, {
  ...collectiveAdjustmentValues(stack),
  ...targets,
});

export const isPreviewableCoachActionPlan = (
  plan: CoachActionPlan,
): plan is PreviewableCoachActionPlan => (
  plan.kind === 'collective-adjustment'
  || plan.kind === 'masked-adjustment'
  || plan.kind === 'canvas-transform'
);

export const isCoachEditPreviewCurrent = (
  source: CoachEditSource,
  photoId: string | undefined,
  versionId: string | undefined,
) => source.sourcePhotoId === photoId && source.sourceVersionId === versionId;

/** Builds the same reversible stack that manual controls commit, without mutating the current version. */
export const buildCoachEditPreview = (
  stack: LayerStack,
  plan: PreviewableCoachActionPlan,
  identity: { id: string; name: string; createdAt: string },
): CoachEditPreview => {
  if (plan.kind === 'collective-adjustment') {
    return { kind: plan.kind, stack: applyCoachAdjustmentTargets(stack, plan.adjustments) };
  }
  if (plan.kind === 'masked-adjustment') {
    return {
      kind: plan.kind,
      stack: appendLayer(stack, {
        id: identity.id,
        type: 'masked-adjustment',
        name: identity.name,
        enabled: true,
        opacity: 1,
        createdAt: identity.createdAt,
        adjustments: plan.adjustments,
        mask: { type: 'polygon', region: plan.target },
      }),
    };
  }
  return {
    kind: plan.kind,
    stack: { ...stack, canvasTransform: plan.transform },
  };
};

export const planCoachAction = (action: CoachAction, currentTransform: CanvasTransform): CoachActionPlan => {
  switch (action.tool) {
    case 'adjust_global':
      return action.adjustments
        ? { kind: 'collective-adjustment', adjustments: action.adjustments }
        : incomplete(action.tool);
    case 'adjust_masked':
      return action.adjustments && action.target
        ? { kind: 'masked-adjustment', adjustments: action.adjustments, target: action.target }
        : incomplete(action.tool);
    case 'crop':
    case 'straighten':
      return action.canvasTransform
        ? {
            kind: 'canvas-transform',
            transform: {
              ...currentTransform,
              ...action.canvasTransform,
              rotationDegrees: currentTransform.rotationDegrees + (action.canvasTransform.rotationDegrees ?? 0),
            },
          }
        : incomplete(action.tool);
    case 'amplify':
      return action.target && action.prompt
        ? { kind: 'generative', target: action.target, prompt: action.prompt }
        : incomplete(action.tool);
    case 'expand': {
      const direction = (['top', 'right', 'bottom', 'left'] as const)
        .find((side) => (action.canvasTransform?.expansion?.[side] ?? 0) > 0);
      const fraction = action.expansionFraction;
      return direction && fraction !== undefined && fraction >= 0.1 && fraction <= 0.5
        ? { kind: 'expand', direction, fraction, prompt: action.prompt ?? 'Extend the scene naturally into the new canvas.' }
        : incomplete(action.tool);
    }
    case 'retake':
      return { kind: 'camera' };
  }
};
