import type { AdjustmentValues, CanvasTransform, Layer, LayerStack, PhotoRecord, PhotoVersion } from './types';
import { identityCanvasTransform } from './types';

const copyStack = (stack: LayerStack): LayerStack => JSON.parse(JSON.stringify(stack)) as LayerStack;

export class StalePhotoVersionError extends Error {
  constructor() {
    super('This photo changed while the edit was processing. Review the latest version and try again.');
    this.name = 'StalePhotoVersionError';
  }
}

export const emptyLayerStack = (): LayerStack => ({
  canvasTransform: identityCanvasTransform(),
  adjustments: {},
  layers: [],
});

const addAdjustmentValues = (target: AdjustmentValues, source: AdjustmentValues, weight = 1) => {
  for (const [key, value] of Object.entries(source) as Array<[keyof AdjustmentValues, number]>) {
    (target as Record<string, number | undefined>)[key] = Math.max(
      -1,
      Math.min(1, (target[key] ?? 0) + value * weight),
    );
  }
};

export const collectiveAdjustmentValues = (stack: LayerStack): AdjustmentValues => {
  const values: AdjustmentValues = { ...(stack.adjustments ?? {}) };
  // Older versions stored each global change as a layer. Fold those values into
  // the collective controls the next time the photo is adjusted.
  for (const layer of stack.layers) {
    if (layer.type === 'adjustment' && layer.enabled) addAdjustmentValues(values, layer.adjustments, layer.opacity);
  }
  return values;
};

export const setCollectiveAdjustments = (stack: LayerStack, adjustments: AdjustmentValues): LayerStack => ({
  ...stack,
  adjustments: Object.fromEntries(
    Object.entries(adjustments).filter(([, value]) => Math.abs(value ?? 0) > 0.0001),
  ) as AdjustmentValues,
  layers: stack.layers.filter((layer) => layer.type !== 'adjustment'),
});

export const mergeCollectiveAdjustments = (stack: LayerStack, adjustments: AdjustmentValues): LayerStack => {
  const merged = collectiveAdjustmentValues(stack);
  addAdjustmentValues(merged, adjustments);
  return setCollectiveAdjustments(stack, merged);
};

export const currentVersion = (photo: PhotoRecord): PhotoVersion => {
  const version = photo.versions.find((candidate) => candidate.id === photo.currentVersionId);
  if (!version) throw new Error('Current photo version is missing');
  return version;
};

export const assertCurrentVersion = (photo: PhotoRecord, expectedVersionId?: string) => {
  if (expectedVersionId && photo.currentVersionId !== expectedVersionId) {
    throw new StalePhotoVersionError();
  }
  return currentVersion(photo);
};

export const makeAdjustmentLayer = (
  id: string,
  adjustments: AdjustmentValues,
  name = 'Manual adjustment',
): Layer => ({
  id,
  type: 'adjustment',
  name,
  enabled: true,
  opacity: 1,
  adjustments,
  createdAt: new Date().toISOString(),
});

export const appendLayer = (stack: LayerStack, layer: Layer): LayerStack => ({
  ...stack,
  canvasTransform: { ...stack.canvasTransform },
  layers: [...stack.layers, layer],
});

export const toggleLayer = (stack: LayerStack, layerId: string): LayerStack => ({
  ...stack,
  canvasTransform: { ...stack.canvasTransform },
  layers: stack.layers.map((layer) =>
    layer.id === layerId ? { ...layer, enabled: !layer.enabled } : layer,
  ),
});

export const setLayerOpacity = (stack: LayerStack, layerId: string, opacity: number): LayerStack => ({
  ...stack,
  canvasTransform: { ...stack.canvasTransform },
  layers: stack.layers.map((layer) =>
    layer.id === layerId ? { ...layer, opacity: Math.max(0, Math.min(1, opacity)) } : layer,
  ),
});

export const reorderLayer = (stack: LayerStack, layerId: string, direction: -1 | 1): LayerStack => {
  const currentIndex = stack.layers.findIndex((layer) => layer.id === layerId);
  const nextIndex = currentIndex + direction;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= stack.layers.length) return stack;
  const layers = [...stack.layers];
  [layers[currentIndex], layers[nextIndex]] = [layers[nextIndex], layers[currentIndex]];
  return { ...stack, canvasTransform: { ...stack.canvasTransform }, layers };
};

export const removeLayer = (stack: LayerStack, layerId: string): LayerStack => {
  const removed = stack.layers.find((layer) => layer.id === layerId);
  const layers = stack.layers.filter((layer) => layer.id !== layerId);
  const canvasTransform = { ...stack.canvasTransform };
  if (removed?.type === 'generative-patch' && removed.canvasSpace) {
    let priorExpansion: CanvasTransform['expansion'];
    for (const layer of [...layers].reverse()) {
      if (layer.type === 'generative-patch' && layer.canvasSpace) {
        priorExpansion = layer.canvasExpansion;
        break;
      }
    }
    if (priorExpansion) canvasTransform.expansion = priorExpansion;
    else delete canvasTransform.expansion;
  }
  return { ...stack, canvasTransform, layers };
};

export const commitVersion = (
  photo: PhotoRecord,
  versionId: string,
  stack: LayerStack,
  label: string,
  restoredFromVersionId?: string,
): PhotoRecord => {
  const nextVersion: PhotoVersion = {
    id: versionId,
    photoId: photo.id,
    parentVersionId: photo.currentVersionId,
    restoredFromVersionId,
    createdAt: new Date().toISOString(),
    label,
    stack: copyStack(stack),
  };
  return {
    ...photo,
    currentVersionId: nextVersion.id,
    versions: [...photo.versions, nextVersion],
    syncState: 'queued',
  };
};

export const restoreVersion = (photo: PhotoRecord, sourceVersionId: string, versionId: string): PhotoRecord => {
  const source = photo.versions.find((version) => version.id === sourceVersionId);
  if (!source) throw new Error('Version to restore is missing');
  return commitVersion(photo, versionId, source.stack, `Restored ${source.label}`, source.id);
};

export const stackWithAllLayersDisabled = (stack: LayerStack): LayerStack => ({
  canvasTransform: identityCanvasTransform(),
  adjustments: {},
  layers: stack.layers.map((layer) => ({ ...layer, enabled: false })),
});
