import type { LayerStack } from './types';

export type LayerAssetReference = {
  id: string;
  uri: string;
  kind: 'mask' | 'donor_patch' | 'imported_image' | 'generated_patch';
  mimeType: 'image/jpeg' | 'image/png';
};

const mimeTypeFor = (uri: string): LayerAssetReference['mimeType'] =>
  /\.png(?:$|\?)/i.test(uri) ? 'image/png' : 'image/jpeg';

export const layerAssetsForStack = (stack: LayerStack): LayerAssetReference[] => {
  const assets: LayerAssetReference[] = [];
  for (const layer of stack.layers) {
    if (layer.type === 'image') {
      assets.push({ id: layer.assetId, uri: layer.uri, kind: 'imported_image', mimeType: mimeTypeFor(layer.uri) });
    } else if (layer.type === 'retouch') {
      assets.push({ id: layer.patchAssetId, uri: layer.patchUri, kind: 'donor_patch', mimeType: mimeTypeFor(layer.patchUri) });
      if (layer.maskUri) assets.push({ id: layer.maskAssetId, uri: layer.maskUri, kind: 'mask', mimeType: 'image/png' });
    } else if (layer.type === 'generative-patch') {
      assets.push({ id: layer.patchAssetId, uri: layer.patchUri, kind: 'generated_patch', mimeType: mimeTypeFor(layer.patchUri) });
      if (layer.maskUri) assets.push({ id: layer.maskAssetId, uri: layer.maskUri, kind: 'mask', mimeType: 'image/png' });
    } else if (layer.type === 'masked-adjustment' && layer.mask.assetId && layer.mask.uri) {
      assets.push({ id: layer.mask.assetId, uri: layer.mask.uri, kind: 'mask', mimeType: mimeTypeFor(layer.mask.uri) });
    }
  }
  return [...new Map(assets.map((asset) => [asset.id, asset])).values()];
};

export const layerAssetsForStacks = (stacks: LayerStack[]) =>
  [...new Map(stacks.flatMap(layerAssetsForStack).map((asset) => [asset.id, asset])).values()];
