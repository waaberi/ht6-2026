import type { AdjustmentValues, Layer, LayerStack, PhotoRecord, PhotoVersion } from './types';
import { identityCanvasTransform } from './types';

const copyStack = (stack: LayerStack): LayerStack => JSON.parse(JSON.stringify(stack)) as LayerStack;

export const emptyLayerStack = (): LayerStack => ({
  canvasTransform: identityCanvasTransform(),
  layers: [],
});

export const currentVersion = (photo: PhotoRecord): PhotoVersion => {
  const version = photo.versions.find((candidate) => candidate.id === photo.currentVersionId);
  if (!version) throw new Error('Current photo version is missing');
  return version;
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
  canvasTransform: { ...stack.canvasTransform },
  layers: [...stack.layers, layer],
});

export const toggleLayer = (stack: LayerStack, layerId: string): LayerStack => ({
  canvasTransform: { ...stack.canvasTransform },
  layers: stack.layers.map((layer) =>
    layer.id === layerId ? { ...layer, enabled: !layer.enabled } : layer,
  ),
});

export const reorderLayer = (stack: LayerStack, layerId: string, direction: -1 | 1): LayerStack => {
  const currentIndex = stack.layers.findIndex((layer) => layer.id === layerId);
  const nextIndex = currentIndex + direction;
  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= stack.layers.length) return stack;
  const layers = [...stack.layers];
  [layers[currentIndex], layers[nextIndex]] = [layers[nextIndex], layers[currentIndex]];
  return { canvasTransform: { ...stack.canvasTransform }, layers };
};

export const removeLayer = (stack: LayerStack, layerId: string): LayerStack => ({
  canvasTransform: { ...stack.canvasTransform },
  layers: stack.layers.filter((layer) => layer.id !== layerId),
});

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
  layers: stack.layers.map((layer) => ({ ...layer, enabled: false })),
});
