import { Canvas, ColorMatrix, Group, Image as SkiaImage, Rect, useImage } from '@shopify/react-native-skia';
import React, { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import type { AnalysisResult, LayerStack } from '../domain/types';
import { colors } from './theme';

const adjustmentMatrix = (stack: LayerStack) => {
  let exposure = 0;
  let contrast = 0;
  let saturation = 0;
  for (const layer of stack.layers) {
    if (!layer.enabled || (layer.type !== 'adjustment' && layer.type !== 'style')) continue;
    const weight = layer.opacity * (layer.type === 'style' ? layer.strength : 1);
    exposure += (layer.adjustments.exposure ?? 0) * weight;
    contrast += (layer.adjustments.contrast ?? 0) * weight;
    saturation += (layer.adjustments.saturation ?? 0) * weight;
  }
  const brightness = 2 ** exposure;
  const c = Math.max(0, 1 + contrast);
  const s = Math.max(0, 1 + saturation);
  const offset = (1 - c) * 0.5;
  const rw = 0.2126 * (1 - s);
  const gw = 0.7152 * (1 - s);
  const bw = 0.0722 * (1 - s);
  return [
    brightness * c * (rw + s), brightness * c * gw, brightness * c * bw, 0, offset,
    brightness * c * rw, brightness * c * (gw + s), brightness * c * bw, 0, offset,
    brightness * c * rw, brightness * c * gw, brightness * c * (bw + s), 0, offset,
    0, 0, 0, 1, 0,
  ];
};

export const PhotoCanvas = ({ uri, stack, analysis }: { uri: string; stack: LayerStack; analysis?: AnalysisResult }) => {
  const image = useImage(uri);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const matrix = useMemo(() => adjustmentMatrix(stack), [stack]);
  const geometry = useMemo(() => {
    const imageWidth = image?.width() ?? 1;
    const imageHeight = image?.height() ?? 1;
    const crop = stack.canvasTransform.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    const croppedWidth = imageWidth * crop.width;
    const croppedHeight = imageHeight * crop.height;
    const scale = Math.min(size.width / croppedWidth, size.height / croppedHeight);
    const displayWidth = croppedWidth * scale;
    const displayHeight = croppedHeight * scale;
    const display = { x: (size.width - displayWidth) / 2, y: (size.height - displayHeight) / 2, width: displayWidth, height: displayHeight };
    const fullWidth = imageWidth * scale;
    const fullHeight = imageHeight * scale;
    return {
      crop,
      display,
      full: { x: display.x - crop.x * fullWidth, y: display.y - crop.y * fullHeight, width: fullWidth, height: fullHeight },
    };
  }, [image, size, stack.canvasTransform.crop]);
  const rotation = -stack.canvasTransform.rotationDegrees * Math.PI / 180;

  return (
    <View
      style={styles.frame}
      onLayout={(event) => setSize(event.nativeEvent.layout)}
      accessibilityLabel="Non-destructive photo preview"
    >
      <Canvas style={StyleSheet.absoluteFill}>
        <Group clip={geometry.display} origin={{ x: size.width / 2, y: size.height / 2 }} transform={[{ rotate: rotation }]}>
          <SkiaImage image={image} {...geometry.full} fit="fill">
            <ColorMatrix matrix={matrix} />
          </SkiaImage>
          {stack.layers.map((layer) => {
            if (!layer.enabled) return null;
            if (layer.type === 'image') return <OverlayImage key={layer.id} uri={layer.uri} opacity={layer.opacity} rect={geometry.full} />;
            if (layer.type === 'retouch' || layer.type === 'generative-patch') return <OverlayImage key={layer.id} uri={layer.patchUri} opacity={layer.opacity} rect={geometry.full} />;
            return null;
          })}
          {analysis?.issues.slice(0, 4).map((issue) => (
            <Rect
              key={issue.id}
              x={geometry.full.x + issue.location.x * geometry.full.width}
              y={geometry.full.y + issue.location.y * geometry.full.height}
              width={issue.location.width * geometry.full.width}
              height={issue.location.height * geometry.full.height}
              color={issue.severity > 0.65 ? colors.danger : colors.amber}
              style="stroke"
              strokeWidth={1.5}
            />
          ))}
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
