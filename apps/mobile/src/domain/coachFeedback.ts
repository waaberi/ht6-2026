import { setCollectiveAdjustments } from './layers';
import type { AdjustmentValues, AnalysisResult, CanvasTransform, LayerStack, Region } from './types';

export type CoachFeedbackSection = 'light' | 'color' | 'detail' | 'crop';

export type CoachFeedbackItem = {
  section: CoachFeedbackSection;
  title: string;
  description: string;
  adjustments?: AdjustmentValues;
  crop?: Region;
  changed: boolean;
};

export type CoachFeedbackPlan = {
  items: [CoachFeedbackItem, CoachFeedbackItem, CoachFeedbackItem, CoachFeedbackItem];
  adjustments: AdjustmentValues;
  crop?: Region;
};

const FULL_FRAME: Region = { x: 0, y: 0, width: 1, height: 1 };

const metric = (analysis: AnalysisResult, key: string, fallback: number) => {
  const value = analysis.metrics[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const clamp = (value: number, minimum = -1, maximum = 1) =>
  Math.max(minimum, Math.min(maximum, Number.isFinite(value) ? value : 0));

const clean = (value: number, minimum = -1, maximum = 1) =>
  Number(clamp(value, minimum, maximum).toFixed(3));

const target = (current: number | undefined, delta: number, minimum = -1, maximum = 1) =>
  clean((current ?? 0) + delta, minimum, maximum);

const hasAdjustmentChange = (current: AdjustmentValues, next: AdjustmentValues) =>
  (Object.keys(next) as Array<keyof AdjustmentValues>)
    .some((key) => Math.abs((next[key] ?? 0) - (current[key] ?? 0)) > 0.001);

const touchesFrameEdge = (region: Region) => (
  region.x < 0.24
  || region.y < 0.24
  || region.x + region.width > 0.76
  || region.y + region.height > 0.76
);

const edgeName = (region: Region): 'left' | 'right' | 'top' | 'bottom' => {
  const centerX = region.x + region.width / 2;
  const centerY = region.y + region.height / 2;
  const distances = [
    ['left', centerX],
    ['right', 1 - centerX],
    ['top', centerY],
    ['bottom', 1 - centerY],
  ] as const;
  return [...distances].sort((left, right) => left[1] - right[1])[0][0];
};

const relativeCropAwayFrom = (region: Region) => {
  const edge = edgeName(region);
  const crop: Region = { ...FULL_FRAME };
  if (edge === 'left') {
    crop.x = clean(region.x + region.width + 0.03, 0.04, 0.24);
    crop.width = clean(1 - crop.x, 0.76, 0.96);
  } else if (edge === 'right') {
    crop.width = clean(region.x - 0.03, 0.76, 0.96);
  } else if (edge === 'top') {
    crop.y = clean(region.y + region.height + 0.03, 0.04, 0.24);
    crop.height = clean(1 - crop.y, 0.76, 0.96);
  } else {
    crop.height = clean(region.y - 0.03, 0.76, 0.96);
  }
  return { edge, crop };
};

const composeCrop = (base: Region | undefined, relative: Region): Region => {
  const source = base ?? FULL_FRAME;
  return {
    x: clean(source.x + relative.x * source.width, 0, 1),
    y: clean(source.y + relative.y * source.height, 0, 1),
    width: clean(source.width * relative.width, 0.01, 1),
    height: clean(source.height * relative.height, 0.01, 1),
  };
};

const cropRecommendation = (analysis: AnalysisResult, transform: CanvasTransform): CoachFeedbackItem => {
  const borderSignal = analysis.signals.find((signal) =>
    signal.signalKey === 'composition.border-saliency-outlier' && touchesFrameEdge(signal.location));
  const distraction = analysis.issues.find((issue) =>
    issue.category === 'distraction' && touchesFrameEdge(issue.location));
  const source = borderSignal ?? distraction;
  if (!source) {
    return {
      section: 'crop',
      title: 'No edge distraction detected',
      description: 'Keep the current crop; no border element is strong enough to justify cutting away.',
      changed: false,
    };
  }
  const relative = relativeCropAwayFrom(source.location);
  const crop = composeCrop(transform.crop, relative.crop);
  return {
    section: 'crop',
    title: `Crop the ${relative.edge} edge`,
    description: `Trim the ${relative.edge} edge to remove the strongest border distraction while retaining most of the frame.`,
    crop,
    changed: true,
  };
};

export const buildCoachFeedback = (
  analysis: AnalysisResult,
  current: AdjustmentValues,
  transform: CanvasTransform,
): CoachFeedbackPlan => {
  const meanLuminance = metric(analysis, 'meanLuminance', analysis.lighting.exposure + 0.5);
  const contrastStd = metric(analysis, 'contrastStd', analysis.lighting.contrast);
  const exposureDelta = meanLuminance < 0.42 || meanLuminance > 0.62
    ? clamp((0.52 - meanLuminance) * 2, -0.8, 0.8)
    : 0;
  const contrastDelta = contrastStd < 0.12
    ? clamp((0.16 - contrastStd) * 2, 0, 0.28)
    : contrastStd > 0.32
      ? -clamp((contrastStd - 0.28) * 0.8, 0, 0.2)
      : 0;
  const light: AdjustmentValues = {
    exposure: target(current.exposure, exposureDelta),
    contrast: target(current.contrast, contrastDelta),
    highlights: target(current.highlights, -clamp(analysis.lighting.clippedHighlights * 5, 0, 0.7)),
    shadows: target(current.shadows, clamp(analysis.lighting.clippedShadows * 3, 0, 0.65)),
  };
  const lightItem: CoachFeedbackItem = {
    section: 'light',
    title: meanLuminance < 0.42
      ? 'Lift underexposure'
      : meanLuminance > 0.62
        ? 'Reduce overexposure'
        : 'Balance highlights and shadows',
    description: meanLuminance < 0.42
      ? 'Raise exposure while protecting bright areas and opening clipped shadows.'
      : meanLuminance > 0.62
        ? 'Lower exposure and highlights to recover bright detail without crushing shadows.'
        : 'Keep overall exposure stable while recovering any clipped highlight or shadow detail.',
    adjustments: light,
    changed: hasAdjustmentChange(current, light),
  };

  const meanSaturation = metric(analysis, 'meanSaturation', 0.28);
  const saturationDelta = meanSaturation < 0.22
    ? clamp((0.3 - meanSaturation) * 3, 0.08, 0.8)
    : meanSaturation > 0.72
      ? -clamp((meanSaturation - 0.62) * 1.5, 0.08, 0.35)
      : 0;
  const vibranceDelta = meanSaturation < 0.3
    ? clamp((0.34 - meanSaturation) * 2, 0.04, 0.5)
    : 0;
  const cast = analysis.lighting.colorCast;
  const color: AdjustmentValues = {
    temperature: target(current.temperature, clamp((cast.blue - cast.red) * 2, -0.3, 0.3)),
    tint: target(current.tint, clamp(-cast.green * 2, -0.24, 0.24)),
    saturation: target(current.saturation, saturationDelta),
    vibrance: target(current.vibrance, vibranceDelta),
  };
  const colorItem: CoachFeedbackItem = {
    section: 'color',
    title: meanSaturation < 0.22
      ? 'Restore dull color'
      : meanSaturation > 0.72
        ? 'Control intense color'
        : 'Neutralize the color cast',
    description: meanSaturation < 0.22
      ? 'Increase saturation and vibrance to reduce grayness, then balance temperature and tint.'
      : meanSaturation > 0.72
        ? 'Reduce saturation while preserving natural color contrast and correcting the cast.'
        : 'Keep color intensity natural and make a small white-balance correction where needed.',
    adjustments: color,
    changed: hasAdjustmentChange(current, color),
  };

  const sharpness = metric(analysis, 'sharpnessLaplacianVariance', 0.003);
  const noise = metric(analysis, 'estimatedNoise', 0.01);
  const isSoft = sharpness < 0.0012;
  const isHarsh = sharpness > 0.012;
  const sharpeningDelta = isSoft
    ? clamp((0.0015 - sharpness) * 350, 0.08, 0.65)
    : isHarsh
      ? -clamp((sharpness - 0.012) * 30, 0.08, 0.65)
      : 0;
  const denoiseDelta = noise > 0.035
    ? clamp((noise - 0.02) * 7, 0.08, 0.65)
    : isHarsh
      ? 0.12
      : 0;
  const detail: AdjustmentValues = {
    sharpening: target(current.sharpening, sharpeningDelta, 0, 1),
    denoise: target(current.denoise, denoiseDelta, 0, 1),
  };
  const detailItem: CoachFeedbackItem = {
    section: 'detail',
    title: isSoft ? 'Clarify soft detail' : isHarsh ? 'Soften harsh detail' : noise > 0.035 ? 'Reduce visible noise' : 'Detail is balanced',
    description: isSoft
      ? 'Add measured sharpening and denoise only enough to improve soft edges without creating halos.'
      : isHarsh
        ? 'Reduce sharpening and add mild denoise to soften brittle edges and oversharpening.'
        : noise > 0.035
          ? 'Use denoise to calm texture while leaving sharpening near its current level.'
          : 'Keep sharpening and denoise restrained because the measured detail is already balanced.',
    adjustments: detail,
    changed: hasAdjustmentChange(current, detail),
  };

  const cropItem = cropRecommendation(analysis, transform);
  return {
    items: [lightItem, colorItem, detailItem, cropItem],
    adjustments: { ...light, ...color, ...detail },
    crop: cropItem.crop,
  };
};

export const applyCoachFeedback = (stack: LayerStack, feedback: CoachFeedbackPlan): LayerStack => {
  const adjusted = setCollectiveAdjustments(stack, feedback.adjustments);
  if (!feedback.crop) return adjusted;
  return {
    ...adjusted,
    canvasTransform: { ...adjusted.canvasTransform, crop: feedback.crop },
  };
};
