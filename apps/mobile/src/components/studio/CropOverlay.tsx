import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
  PanResponder,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';

import {
  type CropCorner,
  type CropViewportSize,
  DEFAULT_CROP_MINIMUM_SIZE,
  moveCropRegion,
  normalizeCropRegion,
  resizeCropRegion,
} from '../../domain/cropGeometry';
import type { Region } from '../../domain/types';
import { colors, layout as appLayout } from '../theme';

export { cropRegionForAspectRatio, normalizeCropRegion } from '../../domain/cropGeometry';
export type { CropViewportSize } from '../../domain/cropGeometry';

export type CropOverlayProps = {
  /** Rectangular crop in normalized image coordinates (0...1). */
  region: Region;
  /** Fires with the final crop before it is committed. */
  onChange: (region: Region) => void;
  /** Fires once when a move or resize interaction ends. */
  onCommit: (region: Region) => void;
  /** Output width / height ratio, for example 1 or 4 / 3. */
  lockedAspectRatio?: number;
  /** Minimum normalized width and height. */
  minimumSize?: number;
  disabled?: boolean;
  showGrid?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
};

const ACCESSIBILITY_STEP = 0.025;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const handleMarkerStyles: Record<CropCorner, ViewStyle> = {
  'top-left': { left: 2, top: 2, borderLeftWidth: 3, borderTopWidth: 3 },
  'top-right': { right: 2, top: 2, borderRightWidth: 3, borderTopWidth: 3 },
  'bottom-left': { left: 2, bottom: 2, borderLeftWidth: 3, borderBottomWidth: 3 },
  'bottom-right': { right: 2, bottom: 2, borderRightWidth: 3, borderBottomWidth: 3 },
};

const handleMarkerShadowStyles: Record<CropCorner, ViewStyle> = {
  'top-left': { left: 0, top: 0, borderLeftWidth: 7, borderTopWidth: 7 },
  'top-right': { right: 0, top: 0, borderRightWidth: 7, borderTopWidth: 7 },
  'bottom-left': { left: 0, bottom: 0, borderLeftWidth: 7, borderBottomWidth: 7 },
  'bottom-right': { right: 0, bottom: 0, borderRightWidth: 7, borderBottomWidth: 7 },
};

const cornerLabels: Record<CropCorner, string> = {
  'top-left': 'Top left crop handle',
  'top-right': 'Top right crop handle',
  'bottom-left': 'Bottom left crop handle',
  'bottom-right': 'Bottom right crop handle',
};

export const CropOverlay = ({
  region,
  onChange,
  onCommit,
  lockedAspectRatio,
  minimumSize = DEFAULT_CROP_MINIMUM_SIZE,
  disabled = false,
  showGrid = true,
  style,
  testID,
}: CropOverlayProps) => {
  const viewportRef = useRef<CropViewportSize>({ width: 0, height: 0 });
  const regionRef = useRef(normalizeCropRegion(region, minimumSize));
  const gestureStartRef = useRef(regionRef.current);
  const gestureRegionRef = useRef(regionRef.current);
  const gestureActiveRef = useRef(false);
  const animationFrameRef = useRef<number | null>(null);
  const onChangeRef = useRef(onChange);
  const onCommitRef = useRef(onCommit);
  const [displayRegion, setDisplayRegion] = useState(regionRef.current);

  const normalizedRegion = normalizeCropRegion(region, minimumSize);
  onChangeRef.current = onChange;
  onCommitRef.current = onCommit;

  useEffect(() => {
    if (gestureActiveRef.current) return;
    regionRef.current = normalizedRegion;
    gestureRegionRef.current = normalizedRegion;
    setDisplayRegion((current) => (
      current.x === normalizedRegion.x
      && current.y === normalizedRegion.y
      && current.width === normalizedRegion.width
      && current.height === normalizedRegion.height
        ? current
        : normalizedRegion
    ));
  }, [normalizedRegion.height, normalizedRegion.width, normalizedRegion.x, normalizedRegion.y]);

  useEffect(() => () => {
    if (animationFrameRef.current !== null) cancelAnimationFrame(animationFrameRef.current);
  }, []);

  const beginGesture = () => {
    const start = normalizeCropRegion(regionRef.current, minimumSize);
    gestureActiveRef.current = true;
    gestureStartRef.current = start;
    gestureRegionRef.current = start;
  };

  const previewRegion = (nextRegion: Region) => {
    const next = normalizeCropRegion(nextRegion, minimumSize);
    regionRef.current = next;
    gestureRegionRef.current = next;
    if (animationFrameRef.current !== null) return;
    animationFrameRef.current = requestAnimationFrame(() => {
      animationFrameRef.current = null;
      setDisplayRegion(gestureRegionRef.current);
    });
  };

  const finishGesture = () => {
    gestureActiveRef.current = false;
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    const next = gestureRegionRef.current;
    regionRef.current = next;
    setDisplayRegion(next);
    onChangeRef.current(next);
    onCommitRef.current(next);
  };

  const moveResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !disabled,
    onMoveShouldSetPanResponder: (_event, gesture) => !disabled && (Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2),
    onPanResponderGrant: beginGesture,
    onPanResponderMove: (_event, gesture) => {
      const viewport = viewportRef.current;
      if (viewport.width <= 0 || viewport.height <= 0) return;
      previewRegion(moveCropRegion(gestureStartRef.current, gesture, viewport));
    },
    onPanResponderRelease: finishGesture,
    onPanResponderTerminate: finishGesture,
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
  // Ref-backed callbacks keep the responder stable without capturing stale state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [disabled, minimumSize]);

  const cornerResponders = useMemo(() => {
    const createResponder = (corner: CropCorner) => PanResponder.create({
      onStartShouldSetPanResponder: () => !disabled,
      onMoveShouldSetPanResponder: () => !disabled,
      onPanResponderGrant: beginGesture,
      onPanResponderMove: (_event, gesture) => {
        const viewport = viewportRef.current;
        if (viewport.width <= 0 || viewport.height <= 0) return;
        previewRegion(resizeCropRegion(
          gestureStartRef.current,
          corner,
          gesture,
          viewport,
          clamp(minimumSize, 0.02, 1),
          lockedAspectRatio,
        ));
      },
      onPanResponderRelease: finishGesture,
      onPanResponderTerminate: finishGesture,
      onPanResponderTerminationRequest: () => false,
      onShouldBlockNativeResponder: () => true,
    });

    return {
      'top-left': createResponder('top-left'),
      'top-right': createResponder('top-right'),
      'bottom-left': createResponder('bottom-left'),
      'bottom-right': createResponder('bottom-right'),
    };
  // Ref-backed callbacks keep the responders stable without capturing stale state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, lockedAspectRatio, minimumSize]);

  const handleLayout = (event: LayoutChangeEvent) => {
    viewportRef.current = {
      width: event.nativeEvent.layout.width,
      height: event.nativeEvent.layout.height,
    };
  };

  const adjustCornerWithAccessibility = (corner: CropCorner, event: AccessibilityActionEvent) => {
    if (disabled || (event.nativeEvent.actionName !== 'increment' && event.nativeEvent.actionName !== 'decrement')) return;
    const viewport = viewportRef.current;
    if (viewport.width <= 0 || viewport.height <= 0) return;
    const direction = event.nativeEvent.actionName === 'increment' ? 1 : -1;
    const movesLeft = corner.endsWith('left');
    const movesTop = corner.startsWith('top');
    const gesture = {
      dx: direction * ACCESSIBILITY_STEP * viewport.width * (movesLeft ? -1 : 1),
      dy: direction * ACCESSIBILITY_STEP * viewport.height * (movesTop ? -1 : 1),
    };
    const next = resizeCropRegion(
      displayRegion,
      corner,
      gesture,
      viewport,
      clamp(minimumSize, 0.02, 1),
      lockedAspectRatio,
    );
    gestureRegionRef.current = next;
    finishGesture();
  };

  const moveFrameWithAccessibility = (event: AccessibilityActionEvent) => {
    if (disabled) return;
    const offsets: Record<string, { dx: number; dy: number }> = {
      'move-left': { dx: -ACCESSIBILITY_STEP, dy: 0 },
      'move-right': { dx: ACCESSIBILITY_STEP, dy: 0 },
      'move-up': { dx: 0, dy: -ACCESSIBILITY_STEP },
      'move-down': { dx: 0, dy: ACCESSIBILITY_STEP },
    };
    const offset = offsets[event.nativeEvent.actionName];
    if (!offset) return;
    const next = {
      ...displayRegion,
      x: clamp(displayRegion.x + offset.dx, 0, 1 - displayRegion.width),
      y: clamp(displayRegion.y + offset.dy, 0, 1 - displayRegion.height),
    };
    gestureRegionRef.current = next;
    finishGesture();
  };

  const frameStyle: ViewStyle = {
    left: `${displayRegion.x * 100}%`,
    top: `${displayRegion.y * 100}%`,
    width: `${displayRegion.width * 100}%`,
    height: `${displayRegion.height * 100}%`,
  };

  const handlePosition = (corner: CropCorner): ViewStyle => {
    const right = 1 - displayRegion.x - displayRegion.width;
    const bottom = 1 - displayRegion.y - displayRegion.height;
    if (corner === 'top-left') return { left: `${displayRegion.x * 100}%`, top: `${displayRegion.y * 100}%` };
    if (corner === 'top-right') return { right: `${right * 100}%`, top: `${displayRegion.y * 100}%` };
    if (corner === 'bottom-left') return { left: `${displayRegion.x * 100}%`, bottom: `${bottom * 100}%` };
    return { right: `${right * 100}%`, bottom: `${bottom * 100}%` };
  };

  return (
    <View
      testID={testID}
      pointerEvents={disabled ? 'none' : 'box-none'}
      style={[StyleSheet.absoluteFill, style]}
      onLayout={handleLayout}
    >
      <View pointerEvents="none" style={[styles.scrim, { left: 0, right: 0, top: 0, height: `${displayRegion.y * 100}%` }]} />
      <View pointerEvents="none" style={[styles.scrim, { left: 0, top: `${displayRegion.y * 100}%`, width: `${displayRegion.x * 100}%`, height: `${displayRegion.height * 100}%` }]} />
      <View pointerEvents="none" style={[styles.scrim, { right: 0, top: `${displayRegion.y * 100}%`, width: `${(1 - displayRegion.x - displayRegion.width) * 100}%`, height: `${displayRegion.height * 100}%` }]} />
      <View pointerEvents="none" style={[styles.scrim, { left: 0, right: 0, bottom: 0, height: `${(1 - displayRegion.y - displayRegion.height) * 100}%` }]} />

      <View
        accessibilityRole="adjustable"
        accessibilityLabel="Crop frame"
        accessibilityHint="Drag to reposition the crop, or use the available screen reader actions"
        accessibilityState={{ disabled }}
        accessibilityActions={[
          { name: 'move-left', label: 'Move crop left' },
          { name: 'move-right', label: 'Move crop right' },
          { name: 'move-up', label: 'Move crop up' },
          { name: 'move-down', label: 'Move crop down' },
        ]}
        style={[styles.frame, frameStyle]}
        onAccessibilityAction={moveFrameWithAccessibility}
        {...moveResponder.panHandlers}
      >
        <View pointerEvents="none" style={styles.frameHighlight} />
        {showGrid ? (
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <View style={[styles.verticalGuide, { left: '33.333%' }]} />
            <View style={[styles.verticalGuide, { left: '66.666%' }]} />
            <View style={[styles.horizontalGuide, { top: '33.333%' }]} />
            <View style={[styles.horizontalGuide, { top: '66.666%' }]} />
          </View>
        ) : null}

      </View>

      {(Object.keys(cornerResponders) as CropCorner[]).map((corner) => (
        <View
          key={corner}
          accessibilityRole="adjustable"
          accessibilityLabel={cornerLabels[corner]}
          accessibilityHint="Drag to resize the crop. Swipe up or down with a screen reader to resize."
          accessibilityState={{ disabled }}
          accessibilityActions={[{ name: 'increment', label: 'Expand crop' }, { name: 'decrement', label: 'Reduce crop' }]}
          style={[styles.handle, handlePosition(corner)]}
          onAccessibilityAction={(event) => adjustCornerWithAccessibility(corner, event)}
          {...cornerResponders[corner].panHandlers}
        >
          <View pointerEvents="none" style={[styles.handleMarkerShadow, handleMarkerShadowStyles[corner]]} />
          <View pointerEvents="none" style={[styles.handleMarker, handleMarkerStyles[corner]]} />
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  scrim: {
    position: 'absolute',
    backgroundColor: colors.overlay,
  },
  frame: {
    position: 'absolute',
    borderWidth: 3,
    borderColor: 'rgba(34,26,27,0.82)',
  },
  frameHighlight: {
    ...StyleSheet.absoluteFillObject,
    margin: -2,
    borderWidth: 1,
    borderColor: colors.text,
  },
  verticalGuide: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
    backgroundColor: colors.text,
    opacity: 0.72,
  },
  horizontalGuide: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.text,
    opacity: 0.72,
  },
  handle: {
    position: 'absolute',
    width: appLayout.minTouchTarget,
    height: appLayout.minTouchTarget,
    zIndex: 2,
  },
  handleMarker: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderColor: colors.primary,
  },
  handleMarkerShadow: {
    position: 'absolute',
    width: 20,
    height: 20,
    borderColor: 'rgba(34,26,27,0.9)',
  },
});
