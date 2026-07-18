import assert from 'node:assert/strict';
import test from 'node:test';

import { layerAssetsForStack } from './assets';
import type { CanvasTransform, LayerStack } from './types';

const identity: CanvasTransform = { rotationDegrees: 0, perspective: [1, 0, 0, 0, 1, 0, 0, 0, 1] };

test('render assets remain addressable independently from layer metadata', () => {
  const stack: LayerStack = {
    canvasTransform: identity,
    layers: [
      {
        id: 'image-layer', type: 'image', name: 'Overlay', enabled: true, opacity: 0.7, createdAt: 'now',
        assetId: 'image-asset', uri: 'file:///overlay.jpg', transform: identity, blendMode: 'screen',
      },
      {
        id: 'patch-layer', type: 'generative-patch', name: 'Patch', enabled: true, opacity: 1, createdAt: 'now',
        patchAssetId: 'patch-asset', patchUri: 'file:///patch.png', maskAssetId: 'mask-asset', maskUri: 'file:///mask.png',
        target: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 }, prompt: 'remove wire',
        provenance: { model: 'fixture', sourceVersionId: 'v1', driftScore: 0 },
      },
    ],
  };

  assert.deepEqual(layerAssetsForStack(stack).map((asset) => [asset.id, asset.kind]), [
    ['image-asset', 'imported_image'],
    ['patch-asset', 'generated_patch'],
    ['mask-asset', 'mask'],
  ]);
});
