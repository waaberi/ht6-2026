import { collectiveAdjustmentValues, setCollectiveAdjustments } from './layers';
import type { AdjustmentValues, CanvasTransform, CoachAction, LayerStack, Region } from './types';

export type CoachActionPlan =
  | { kind: 'collective-adjustment'; adjustments: AdjustmentValues }
  | { kind: 'masked-adjustment'; adjustments: AdjustmentValues; target: Region }
  | { kind: 'canvas-transform'; transform: CanvasTransform }
  | { kind: 'generative'; operation: 'remove' | 'add'; target: Region; prompt: string }
  | { kind: 'expand'; direction: 'top' | 'right' | 'bottom' | 'left'; fraction: number; prompt: string }
  | { kind: 'camera' };

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
    case 'remove':
    case 'add':
      return action.target
        ? { kind: 'generative', operation: action.tool, target: action.target, prompt: action.prompt ?? action.reason }
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
