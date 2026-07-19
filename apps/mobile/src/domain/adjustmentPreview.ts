import type { AdjustmentValues, LayerStack } from './types';

export const addPreviewAdjustments = (
  target: AdjustmentValues,
  source: AdjustmentValues,
  weight = 1,
) => {
  for (const [key, value] of Object.entries(source) as Array<[keyof AdjustmentValues, number]>) {
    (target as Record<string, number>)[key] = (target[key] ?? 0) + value * weight;
  }
};

export const globalPreviewAdjustments = (stack: LayerStack) => {
  const values: AdjustmentValues = { ...(stack.adjustments ?? {}) };
  for (const layer of stack.layers) {
    if (!layer.enabled || (layer.type !== 'adjustment' && layer.type !== 'style')) continue;
    const weight = layer.opacity * (layer.type === 'style' ? layer.strength : 1);
    addPreviewAdjustments(values, layer.adjustments, weight);
  }
  return values;
};

export const adjustmentPreviewMatrix = (values: AdjustmentValues) => {
  const exposure = values.exposure ?? 0;
  const contrast = (values.contrast ?? 0) + (values.sharpening ?? 0) * 0.18;
  const saturation = (values.saturation ?? 0) + (values.vibrance ?? 0) * 0.55;
  const highlights = values.highlights ?? 0;
  const shadows = values.shadows ?? 0;
  const temperature = values.temperature ?? 0;
  const tint = values.tint ?? 0;
  const brightness = 2 ** exposure;
  const c = Math.max(0, 1 + contrast);
  const s = Math.max(0, 1 + saturation);
  // A color matrix accurately previews exposure, contrast, saturation, temperature, and tint.
  // Highlight/shadow offsets are intentionally conservative approximations; detail filters remain authoritative on export.
  const toneScale = brightness * Math.max(0.2, 1 + highlights * 0.16);
  const offset = (1 - c) * 0.5 + shadows * 0.12;
  const rw = 0.2126 * (1 - s);
  const gw = 0.7152 * (1 - s);
  const bw = 0.0722 * (1 - s);
  return [
    toneScale * c * (rw + s), toneScale * c * gw, toneScale * c * bw, 0, offset + temperature * 0.08,
    toneScale * c * rw, toneScale * c * (gw + s), toneScale * c * bw, 0, offset + tint * 0.06,
    toneScale * c * rw, toneScale * c * gw, toneScale * c * (bw + s), 0, offset - temperature * 0.08,
    0, 0, 0, 1, 0,
  ];
};
