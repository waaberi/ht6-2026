import {
  Blur,
  Canvas,
  ColorMatrix,
  FractalNoise,
  Group,
  Image as SkiaImage,
  RadialGradient,
  Rect,
  useImage,
} from '@shopify/react-native-skia';
import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { AdjustmentValues, AnalysisResult, LayerStack, Region } from '../domain/types';
import { colors } from './theme';

const addAdjustments = (target: AdjustmentValues, source: AdjustmentValues, weight = 1) => {
  for (const [key, value] of Object.entries(source) as Array<[keyof AdjustmentValues, number]>) {
    (target as Record<string, number>)[key] = (target[key] ?? 0) + value * weight;
  }
};

const globalAdjustments = (stack: LayerStack) => {
  const values: AdjustmentValues = { ...(stack.adjustments ?? {}) };
  for (const layer of stack.layers) {
    if (!layer.enabled || (layer.type !== 'adjustment' && layer.type !== 'style')) continue;
    const weight = layer.opacity * (layer.type === 'style' ? layer.strength : 1);
    addAdjustments(values, layer.adjustments, weight);
  }
  return values;
};

const adjustmentMatrix = (values: AdjustmentValues) => {
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

export const PhotoCanvas = ({
  uri,
  stack,
  analysis,
  target,
  showIssues = true,
}: {
  uri: string;
  stack: LayerStack;
  analysis?: AnalysisResult;
  target?: Region;
  showIssues?: boolean;
}) => {
  const image = useImage(uri);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const adjustments = useMemo(() => globalAdjustments(stack), [stack]);
  const matrix = useMemo(() => adjustmentMatrix(adjustments), [adjustments]);
  const denoise = Math.max(0, adjustments.denoise ?? 0);
  const grain = Math.max(0, adjustments.grain ?? 0);
  const vignette = Math.max(-1, Math.min(1, adjustments.vignette ?? 0));
  const geometry = useMemo(() => {
    const imageWidth = image?.width() ?? 1;
    const imageHeight = image?.height() ?? 1;
    const crop = stack.canvasTransform.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    const expansion = stack.canvasTransform.expansion ?? { top: 0, right: 0, bottom: 0, left: 0 };
    const croppedWidth = imageWidth * crop.width;
    const croppedHeight = imageHeight * crop.height;
    const expandedWidth = croppedWidth + expansion.left + expansion.right;
    const expandedHeight = croppedHeight + expansion.top + expansion.bottom;
    const scale = Math.min(size.width / expandedWidth, size.height / expandedHeight);
    const displayWidth = expandedWidth * scale;
    const displayHeight = expandedHeight * scale;
    const display = { x: (size.width - displayWidth) / 2, y: (size.height - displayHeight) / 2, width: displayWidth, height: displayHeight };
    const fullWidth = imageWidth * scale;
    const fullHeight = imageHeight * scale;
    const cropped = {
      x: display.x + expansion.left * scale,
      y: display.y + expansion.top * scale,
      width: croppedWidth * scale,
      height: croppedHeight * scale,
    };
    return {
      crop,
      expansion,
      scale,
      croppedWidth,
      croppedHeight,
      display,
      full: { x: cropped.x - crop.x * fullWidth, y: cropped.y - crop.y * fullHeight, width: fullWidth, height: fullHeight },
    };
  }, [image, size, stack.canvasTransform.crop, stack.canvasTransform.expansion]);
  const rotation = -stack.canvasTransform.rotationDegrees * Math.PI / 180;

  return (
    <View
      style={styles.frame}
      onLayout={(event) => setSize(event.nativeEvent.layout)}
      accessibilityLabel="Non-destructive photo preview"
    >
      <Canvas style={StyleSheet.absoluteFill}>
        <Group clip={geometry.display}>
          <Group origin={{ x: size.width / 2, y: size.height / 2 }} transform={[{ rotate: rotation }]}>
            <SkiaImage image={image} {...geometry.full} fit="fill">
              <ColorMatrix matrix={matrix} />
              {denoise > 0 ? <Blur blur={denoise * 1.5} /> : null}
            </SkiaImage>
            {stack.layers.map((layer) => {
              if (!layer.enabled || layer.type !== 'masked-adjustment' || !layer.mask.region) return null;
              const maskedValues = { ...adjustments };
              addAdjustments(maskedValues, layer.adjustments, layer.opacity);
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
                    <ColorMatrix matrix={adjustmentMatrix(maskedValues)} />
                  </SkiaImage>
                </Group>
              );
            })}
            {stack.layers.map((layer) => {
              if (!layer.enabled) return null;
              if (layer.type === 'image') return <OverlayImage key={layer.id} uri={layer.uri} opacity={layer.opacity} rect={geometry.full} />;
              if (layer.type === 'retouch') return <OverlayImage key={layer.id} uri={layer.patchUri} opacity={layer.opacity} rect={geometry.full} />;
              if (layer.type === 'generative-patch' && !layer.canvasSpace) return <OverlayImage key={layer.id} uri={layer.patchUri} opacity={layer.opacity} rect={geometry.full} />;
              return null;
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
          {stack.layers.map((layer) => {
            if (!layer.enabled || layer.type !== 'generative-patch' || !layer.canvasSpace) return null;
            const snapshot = layer.canvasExpansion ?? geometry.expansion;
            const rect = {
              x: geometry.display.x + (geometry.expansion.left - snapshot.left) * geometry.scale,
              y: geometry.display.y + (geometry.expansion.top - snapshot.top) * geometry.scale,
              width: (geometry.croppedWidth + snapshot.left + snapshot.right) * geometry.scale,
              height: (geometry.croppedHeight + snapshot.top + snapshot.bottom) * geometry.scale,
            };
            return <OverlayImage key={layer.id} uri={layer.patchUri} opacity={layer.opacity} rect={rect} />;
          })}
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
          {target ? (
            <Rect
              x={geometry.display.x + target.x * geometry.display.width}
              y={geometry.display.y + target.y * geometry.display.height}
              width={target.width * geometry.display.width}
              height={target.height * geometry.display.height}
              color={colors.lime}
              style="stroke"
              strokeWidth={3}
            />
          ) : null}
        </Group>
      </Canvas>
    </View>
  );
};

const OverlayImage = ({ uri, opacity, rect }: { uri: string; opacity: number; rect: { x: number; y: number; width: number; height: number } }) => {
  const image = useImage(uri);
  return (
    <Group opacity={opacity}>
      <SkiaImage image={image} {...rect} fit="fill" />
    </Group>
  );
};

const styles = StyleSheet.create({
  frame: { flex: 1, overflow: 'hidden', backgroundColor: colors.canvas },
});
