import {
  Blur,
  Canvas,
  ColorMatrix,
  FractalNoise,
  Group,
  Image as SkiaImage,
  Paint,
  RadialGradient,
  Rect,
  useImage,
} from '@shopify/react-native-skia';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View } from 'react-native';

import { addPreviewAdjustments, adjustmentPreviewMatrix, globalPreviewAdjustments } from '../domain/adjustmentPreview';
import { quarterTurnsForRotation, resolveCanvasExpansion } from '../domain/canvasTransforms';
import { isTranslatableLayer, layerTranslation } from '../domain/layers';
import type { AdjustmentValues, AnalysisResult, Layer, LayerStack, LayerTranslation, Region } from '../domain/types';
import { colors } from './theme';
import { CropOverlay } from './studio/CropOverlay';

export const PhotoCanvas = ({
  uri,
  stack,
  analysis,
  target,
  onTargetChange,
  showIssues = true,
  editingCrop = false,
  cropRegion,
  cropAspect,
  onCropChange,
  onCropCommit,
  onImageSizeChange,
  onGeneratedLayerReady,
  onGeneratedLayerError,
  movableLayerId,
  onLayerTranslationChange,
  hiddenFromAccessibility = false,
  contentFit = 'contain',
}: {
  uri: string;
  stack: LayerStack;
  analysis?: AnalysisResult;
  target?: Region;
  onTargetChange?: (target: Region) => void;
  showIssues?: boolean;
  editingCrop?: boolean;
  cropRegion?: Region;
  cropAspect?: number;
  onCropChange?: (region: Region) => void;
  onCropCommit?: (region: Region) => void;
  onImageSizeChange?: (size: { width: number; height: number }) => void;
  onGeneratedLayerReady?: (layerId: string) => void;
  onGeneratedLayerError?: (layerId: string, error: Error) => void;
  movableLayerId?: string;
  onLayerTranslationChange?: (layerId: string, translation: LayerTranslation, commit: boolean) => void;
  hiddenFromAccessibility?: boolean;
  contentFit?: 'contain' | 'cover';
}) => {
  const image = useImage(uri);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const adjustments = useMemo(() => globalPreviewAdjustments(stack), [stack]);
  const matrix = useMemo(() => adjustmentPreviewMatrix(adjustments), [adjustments]);
  const denoise = Math.max(0, adjustments.denoise ?? 0);
  const grain = Math.max(0, adjustments.grain ?? 0);
  const vignette = Math.max(-1, Math.min(1, adjustments.vignette ?? 0));
  const rotationDegrees = stack.canvasTransform.rotationDegrees;
  const quarterTurns = quarterTurnsForRotation(rotationDegrees);
  const swapsDimensions = Math.abs(quarterTurns) % 2 === 1;
  const straightenDegrees = rotationDegrees - quarterTurns * 90;
  const rotation = -rotationDegrees * Math.PI / 180;

  useEffect(() => {
    if (!image || !onImageSizeChange) return;
    const width = image.width();
    const height = image.height();
    if (width > 0 && height > 0) onImageSizeChange({ width, height });
  }, [image, onImageSizeChange]);

  const geometry = useMemo(() => {
    const imageWidth = image?.width() ?? 1;
    const imageHeight = image?.height() ?? 1;
    const crop = editingCrop ? { x: 0, y: 0, width: 1, height: 1 } : stack.canvasTransform.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    const expansionSource = stack.canvasTransform.expansion;
    const rotatedWidth = swapsDimensions ? imageHeight : imageWidth;
    const rotatedHeight = swapsDimensions ? imageWidth : imageHeight;
    const croppedWidth = rotatedWidth * crop.width;
    const croppedHeight = rotatedHeight * crop.height;
    const contentWidth = croppedWidth;
    const contentHeight = croppedHeight;
    const expansion = resolveCanvasExpansion(expansionSource, contentWidth, contentHeight);
    const expandedWidth = contentWidth + expansion.left + expansion.right;
    const expandedHeight = contentHeight + expansion.top + expansion.bottom;
    const scale = contentFit === 'cover'
      ? Math.max(size.width / expandedWidth, size.height / expandedHeight)
      : Math.min(size.width / expandedWidth, size.height / expandedHeight);
    const displayWidth = expandedWidth * scale;
    const displayHeight = expandedHeight * scale;
    const display = { x: (size.width - displayWidth) / 2, y: (size.height - displayHeight) / 2, width: displayWidth, height: displayHeight };
    const fullWidth = imageWidth * scale;
    const fullHeight = imageHeight * scale;
    const content = {
      x: display.x + expansion.left * scale,
      y: display.y + expansion.top * scale,
      width: contentWidth * scale,
      height: contentHeight * scale,
    };
    const rotated = {
      x: content.x - crop.x * rotatedWidth * scale,
      y: content.y - crop.y * rotatedHeight * scale,
      width: rotatedWidth * scale,
      height: rotatedHeight * scale,
    };
    const center = { x: rotated.x + rotated.width / 2, y: rotated.y + rotated.height / 2 };
    const straightenRadians = Math.abs(straightenDegrees) * Math.PI / 180;
    const cosine = Math.abs(Math.cos(straightenRadians));
    const sine = Math.abs(Math.sin(straightenRadians));
    const straightenScale = Math.max(
      (rotatedWidth * cosine + rotatedHeight * sine) / Math.max(1, rotatedWidth),
      (rotatedWidth * sine + rotatedHeight * cosine) / Math.max(1, rotatedHeight),
    );
    return {
      expansion,
      expansionSource,
      scale,
      contentWidth,
      contentHeight,
      display,
      content,
      center,
      straightenScale,
      full: { x: center.x - fullWidth / 2, y: center.y - fullHeight / 2, width: fullWidth, height: fullHeight },
    };
  }, [contentFit, editingCrop, image, size, stack.canvasTransform.crop, stack.canvasTransform.expansion, straightenDegrees, swapsDimensions]);
  const selectionStart = useRef<{ x: number; y: number } | null>(null);
  const selectionResponder = useMemo(() => {
    const display = geometry.display;
    const normalize = (x: number, y: number) => ({
      x: Math.max(0, Math.min(1, (x - display.x) / Math.max(1, display.width))),
      y: Math.max(0, Math.min(1, (y - display.y) / Math.max(1, display.height))),
    });
    const isInside = (x: number, y: number) => (
      x >= display.x
      && x <= display.x + display.width
      && y >= display.y
      && y <= display.y + display.height
    );
    const updateSelection = (x: number, y: number, final = false) => {
      if (!onTargetChange || !selectionStart.current) return;
      const end = normalize(x, y);
      const start = selectionStart.current;
      let left = Math.min(start.x, end.x);
      let top = Math.min(start.y, end.y);
      let width = Math.abs(end.x - start.x);
      let height = Math.abs(end.y - start.y);
      if (final && width < 0.025 && height < 0.025) {
        width = 0.18;
        height = 0.18;
        left = Math.max(0, Math.min(1 - width, end.x - width / 2));
        top = Math.max(0, Math.min(1 - height, end.y - height / 2));
      } else {
        width = Math.max(0.005, width);
        height = Math.max(0.005, height);
      }
      onTargetChange({ x: left, y: top, width: Math.min(1 - left, width), height: Math.min(1 - top, height) });
    };
    return PanResponder.create({
      onStartShouldSetPanResponderCapture: (event) => Boolean(
        onTargetChange
        && event.nativeEvent.touches.length === 1
        && isInside(event.nativeEvent.locationX, event.nativeEvent.locationY),
      ),
      onMoveShouldSetPanResponderCapture: (event) => Boolean(
        onTargetChange
        && event.nativeEvent.touches.length === 1
        && isInside(event.nativeEvent.locationX, event.nativeEvent.locationY),
      ),
      onPanResponderGrant: (event) => {
        selectionStart.current = normalize(event.nativeEvent.locationX, event.nativeEvent.locationY);
      },
      onPanResponderMove: (event) => updateSelection(event.nativeEvent.locationX, event.nativeEvent.locationY),
      onPanResponderRelease: (event) => {
        updateSelection(event.nativeEvent.locationX, event.nativeEvent.locationY, true);
        selectionStart.current = null;
      },
      onPanResponderTerminate: () => { selectionStart.current = null; },
      onPanResponderTerminationRequest: () => false,
    });
  }, [geometry.display, onTargetChange]);
  const movableLayer = stack.layers.find((layer) => (
    layer.id === movableLayerId && layer.enabled && isTranslatableLayer(layer)
  ));
  const movableLayerRef = useRef(movableLayer);
  const movableLayerIdRef = useRef(movableLayerId);
  const layerTranslationChangeRef = useRef(onLayerTranslationChange);
  movableLayerRef.current = movableLayer;
  movableLayerIdRef.current = movableLayerId;
  layerTranslationChangeRef.current = onLayerTranslationChange;
  const moveStart = useRef<LayerTranslation | null>(null);
  const layerMoveResponder = useMemo(() => {
    const display = geometry.display;
    const translated = (dx: number, dy: number): LayerTranslation | undefined => {
      if (!movableLayerIdRef.current || !moveStart.current) return undefined;
      return {
        x: Math.max(-1, Math.min(1, moveStart.current.x + dx / Math.max(1, display.width))),
        y: Math.max(-1, Math.min(1, moveStart.current.y + dy / Math.max(1, display.height))),
      };
    };
    return PanResponder.create({
      onStartShouldSetPanResponder: () => Boolean(movableLayerRef.current && layerTranslationChangeRef.current),
      onMoveShouldSetPanResponder: (_event, gesture) => Boolean(
        movableLayerRef.current
        && layerTranslationChangeRef.current
        && (Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2),
      ),
      onPanResponderGrant: () => {
        if (movableLayerRef.current) moveStart.current = layerTranslation(movableLayerRef.current);
      },
      onPanResponderMove: (_event, gesture) => {
        const next = translated(gesture.dx, gesture.dy);
        const layerId = movableLayerIdRef.current;
        if (next && layerId) layerTranslationChangeRef.current?.(layerId, next, false);
      },
      onPanResponderRelease: (_event, gesture) => {
        const next = translated(gesture.dx, gesture.dy);
        const layerId = movableLayerIdRef.current;
        moveStart.current = null;
        if (next && layerId) layerTranslationChangeRef.current?.(layerId, next, true);
      },
      onPanResponderTerminate: () => { moveStart.current = null; },
      onPanResponderTerminationRequest: () => false,
    });
  }, [geometry.display.height, geometry.display.width]);
  const targetRect = target ? {
    x: geometry.display.x + target.x * geometry.display.width,
    y: geometry.display.y + target.y * geometry.display.height,
    width: target.width * geometry.display.width,
    height: target.height * geometry.display.height,
  } : undefined;

  return (
    <View
      style={styles.frame}
      onLayout={(event) => setSize(event.nativeEvent.layout)}
      accessible={!hiddenFromAccessibility}
      accessibilityElementsHidden={hiddenFromAccessibility}
      importantForAccessibility={hiddenFromAccessibility ? 'no-hide-descendants' : 'auto'}
      accessibilityLabel={hiddenFromAccessibility
        ? undefined
        : onTargetChange
          ? 'Photo preview. Drag to select an area.'
          : movableLayer
            ? `Photo preview. Drag to move ${movableLayer.name}.`
            : 'Non-destructive photo preview'}
      accessibilityHint={hiddenFromAccessibility
        ? undefined
        : onTargetChange
          ? 'Drag a rectangle over the area for the AI edit.'
          : movableLayer
            ? 'Drag anywhere on the canvas, or use the precise position controls below.'
            : undefined}
      {...(onTargetChange ? selectionResponder.panHandlers : layerMoveResponder.panHandlers)}
    >
      <Canvas style={StyleSheet.absoluteFill}>
        <Group clip={geometry.display}>
          <Group
            layer={(
              <Paint>
                <ColorMatrix matrix={matrix} />
                {denoise > 0 ? <Blur blur={denoise * 1.5} /> : null}
              </Paint>
            )}
          >
            <Group clip={geometry.content}>
              <Group origin={geometry.center} transform={[{ scale: geometry.straightenScale }, { rotate: rotation }]}>
                <SkiaImage image={image} {...geometry.full} fit="fill" />
                {stack.layers.map((layer) => {
                  if (!layer.enabled || layer.type !== 'masked-adjustment' || !layer.mask.region) return null;
                  const maskedValues: AdjustmentValues = {};
                  addPreviewAdjustments(maskedValues, layer.adjustments, layer.opacity);
                  const region = layer.mask.region;
                  const clip = {
                    x: geometry.full.x + region.x * geometry.full.width,
                    y: geometry.full.y + region.y * geometry.full.height,
                    width: region.width * geometry.full.width,
                    height: region.height * geometry.full.height,
                  };
                  return (
                    <Group key={layer.id} clip={clip}>
                      <SkiaImage image={image} {...geometry.full} fit="fill">
                        <ColorMatrix matrix={adjustmentPreviewMatrix(maskedValues)} />
                      </SkiaImage>
                    </Group>
                  );
                })}
                {stack.layers.map((layer) => {
                  if (!layer.enabled) return null;
                  if (layer.type === 'image') return <OverlayImage key={layer.id} uri={layer.uri} opacity={layer.opacity} blendMode={layer.blendMode} rect={translatedLayerRect(geometry.full, geometry.display, layer, rotation)} />;
                  if (layer.type === 'retouch') return <OverlayImage key={layer.id} uri={layer.patchUri} opacity={layer.opacity} rect={translatedLayerRect(geometry.full, geometry.display, layer, rotation)} />;
                  if (layer.type === 'generative-patch' && !layer.canvasSpace) {
                    return (
                      <OverlayImage
                        key={layer.id}
                        uri={layer.patchUri}
                        opacity={layer.opacity}
                        rect={translatedLayerRect(geometry.full, geometry.display, layer, rotation)}
                        onLoad={() => onGeneratedLayerReady?.(layer.id)}
                        onError={(error) => onGeneratedLayerError?.(layer.id, error)}
                      />
                    );
                  }
                  return null;
                })}
              </Group>
            </Group>
            {stack.layers.map((layer) => {
              if (!layer.enabled || layer.type !== 'generative-patch' || !layer.canvasSpace) return null;
              const snapshot = resolveCanvasExpansion(
                layer.canvasExpansion ?? geometry.expansionSource,
                geometry.contentWidth,
                geometry.contentHeight,
              );
              const rect = {
                x: geometry.display.x + (geometry.expansion.left - snapshot.left) * geometry.scale,
                y: geometry.display.y + (geometry.expansion.top - snapshot.top) * geometry.scale,
                width: (geometry.contentWidth + snapshot.left + snapshot.right) * geometry.scale,
                height: (geometry.contentHeight + snapshot.top + snapshot.bottom) * geometry.scale,
              };
              return (
                <OverlayImage
                  key={layer.id}
                  uri={layer.patchUri}
                  opacity={layer.opacity}
                  rect={translatedLayerRect(rect, geometry.display, layer)}
                  onLoad={() => onGeneratedLayerReady?.(layer.id)}
                  onError={(error) => onGeneratedLayerError?.(layer.id, error)}
                />
              );
            })}
          </Group>
          {grain > 0 ? (
            <Group opacity={grain * 0.16} blendMode="overlay">
              <Rect {...geometry.display}>
                <FractalNoise freqX={0.72} freqY={0.72} octaves={1} seed={7} />
              </Rect>
            </Group>
          ) : null}
          {vignette !== 0 ? (
            <Group opacity={Math.abs(vignette) * 0.72} blendMode={vignette > 0 ? 'multiply' : 'screen'}>
              <Rect {...geometry.display}>
                <RadialGradient
                  c={{ x: geometry.display.x + geometry.display.width / 2, y: geometry.display.y + geometry.display.height / 2 }}
                  r={Math.max(1, Math.max(geometry.display.width, geometry.display.height) * 0.68)}
                  colors={vignette > 0 ? ['rgba(0,0,0,0)', '#000000'] : ['rgba(255,255,255,0)', '#FFFFFF']}
                  positions={[0.42, 1]}
                />
              </Rect>
            </Group>
          ) : null}
          {showIssues ? analysis?.issues.slice(0, 4).map((issue) => (
            <Rect
              key={issue.id}
              x={geometry.display.x + issue.location.x * geometry.display.width}
              y={geometry.display.y + issue.location.y * geometry.display.height}
              width={issue.location.width * geometry.display.width}
              height={issue.location.height * geometry.display.height}
              color={issue.severity > 0.65 ? colors.danger : colors.amber}
              style="stroke"
              strokeWidth={1.5}
            />
          )) : null}
          {targetRect ? (
            <Group>
              <Rect x={geometry.display.x} y={geometry.display.y} width={geometry.display.width} height={Math.max(0, targetRect.y - geometry.display.y)} color="rgba(34,26,27,0.44)" />
              <Rect x={geometry.display.x} y={targetRect.y + targetRect.height} width={geometry.display.width} height={Math.max(0, geometry.display.y + geometry.display.height - targetRect.y - targetRect.height)} color="rgba(34,26,27,0.44)" />
              <Rect x={geometry.display.x} y={targetRect.y} width={Math.max(0, targetRect.x - geometry.display.x)} height={targetRect.height} color="rgba(34,26,27,0.44)" />
              <Rect x={targetRect.x + targetRect.width} y={targetRect.y} width={Math.max(0, geometry.display.x + geometry.display.width - targetRect.x - targetRect.width)} height={targetRect.height} color="rgba(34,26,27,0.44)" />
              <Rect {...targetRect} color={colors.primary} style="stroke" strokeWidth={3} />
            </Group>
          ) : null}
          {movableLayer ? (
            <Rect {...geometry.display} color={colors.primary} style="stroke" strokeWidth={2} />
          ) : null}
        </Group>
      </Canvas>
      {editingCrop && onCropChange && onCropCommit ? (
        <View
          pointerEvents="box-none"
          style={[
            styles.cropViewport,
            {
              left: geometry.content.x,
              top: geometry.content.y,
              width: geometry.content.width,
              height: geometry.content.height,
            },
          ]}
        >
          <CropOverlay
            region={cropRegion ?? stack.canvasTransform.crop ?? { x: 0, y: 0, width: 1, height: 1 }}
            lockedAspectRatio={cropAspect}
            disabled={!image}
            onChange={onCropChange}
            onCommit={onCropCommit}
          />
        </View>
      ) : null}
    </View>
  );
};

const translatedLayerRect = (
  rect: { x: number; y: number; width: number; height: number },
  canvas: { width: number; height: number },
  layer: Layer,
  appliedRotation = 0,
) => {
  const translation = layerTranslation(layer);
  const desiredX = translation.x * canvas.width;
  const desiredY = translation.y * canvas.height;
  const cosine = Math.cos(appliedRotation);
  const sine = Math.sin(appliedRotation);
  return {
    ...rect,
    // Pixel overlays live inside the photo's rotation group. Convert the
    // canvas-axis offset back into local coordinates so X still moves right
    // and Y still moves down after the photo is rotated.
    x: rect.x + cosine * desiredX - sine * desiredY,
    y: rect.y + sine * desiredX + cosine * desiredY,
  };
};

const OverlayImage = ({
  uri,
  opacity,
  blendMode = 'normal',
  rect,
  onLoad,
  onError,
}: {
  uri: string;
  opacity: number;
  blendMode?: 'normal' | 'multiply' | 'screen' | 'overlay';
  rect: { x: number; y: number; width: number; height: number };
  onLoad?: () => void;
  onError?: (error: Error) => void;
}) => {
  const image = useImage(uri, onError);
  const reportedUriRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!image || reportedUriRef.current === uri) return;
    reportedUriRef.current = uri;
    onLoad?.();
  }, [image, onLoad, uri]);
  const skiaBlendMode = blendMode === 'normal' ? 'srcOver' : blendMode;
  if (!image) return null;
  return (
    <Group opacity={opacity} blendMode={skiaBlendMode}>
      <SkiaImage image={image} {...rect} fit="fill" />
    </Group>
  );
};

const styles = StyleSheet.create({
  frame: { flex: 1, overflow: 'hidden', backgroundColor: colors.canvas },
  cropViewport: { position: 'absolute' },
});
