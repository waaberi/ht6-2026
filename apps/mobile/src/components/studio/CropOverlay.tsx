import React, { useMemo, useRef } from 'react';
import {
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
  PanResponder,
  type PanResponderGestureState,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';

import type { Region } from '../../domain/types';
import { colors, layout as appLayout } from '../theme';

type CropCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export type CropViewportSize = {
  width: number;
  height: number;
};

export type CropOverlayProps = {
  /** Rectangular crop in normalized image coordinates (0...1). */
  region: Region;
  /** Fires continuously while the crop is moved or resized. */
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

const DEFAULT_REGION: Region = { x: 0, y: 0, width: 1, height: 1 };
const DEFAULT_MINIMUM_SIZE = 0.12;
const ACCESSIBILITY_STEP = 0.025;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const finiteOr = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

/**
 * Keeps a rectangular crop finite, large enough, and entirely inside normalized
 * image bounds. Optional Region mask metadata is intentionally omitted because
 * a crop frame only represents a rectangle.
 */
export const normalizeCropRegion = (region: Region, minimumSize = DEFAULT_MINIMUM_SIZE): Region => {
  const minimum = clamp(finiteOr(minimumSize, DEFAULT_MINIMUM_SIZE), 0.02, 1);
  const width = clamp(finiteOr(region.width, DEFAULT_REGION.width), minimum, 1);
  const height = clamp(finiteOr(region.height, DEFAULT_REGION.height), minimum, 1);

  return {
    x: clamp(finiteOr(region.x, DEFAULT_REGION.x), 0, 1 - width),
    y: clamp(finiteOr(region.y, DEFAULT_REGION.y), 0, 1 - height),
    width,
    height,
  };
};

/**
 * Returns the largest centered crop inside `region` that matches an output
 * pixel aspect ratio. Use this when a ratio preset changes before passing the
 * resulting controlled value back to CropOverlay.
 */
export const cropRegionForAspectRatio = (
  region: Region,
  aspectRatio: number,
  viewport: CropViewportSize,
  minimumSize = DEFAULT_MINIMUM_SIZE,
): Region => {
  const source = normalizeCropRegion(region, minimumSize);
  if (
    !Number.isFinite(aspectRatio)
    || aspectRatio <= 0
    || viewport.width <= 0
    || viewport.height <= 0
  ) {
    return source;
  }

  // Normalized width / height differs from output pixel width / height when
  // the displayed image is not square.
  const normalizedAspect = aspectRatio * viewport.height / viewport.width;
  let width = source.width;
  let height = source.height;

  if (width / height > normalizedAspect) {
    width = height * normalizedAspect;
  } else {
    height = width / normalizedAspect;
  }

  const centerX = source.x + source.width / 2;
  const centerY = source.y + source.height / 2;
  return normalizeCropRegion({
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
  }, minimumSize);
};

const moveRegion = (
  source: Region,
  gesture: PanResponderGestureState,
  viewport: CropViewportSize,
): Region => ({
  ...source,
  x: clamp(source.x + gesture.dx / viewport.width, 0, 1 - source.width),
  y: clamp(source.y + gesture.dy / viewport.height, 0, 1 - source.height),
});

const resizeRegion = (
  source: Region,
  corner: CropCorner,
  gesture: Pick<PanResponderGestureState, 'dx' | 'dy'>,
  viewport: CropViewportSize,
  minimumSize: number,
  lockedAspectRatio?: number,
): Region => {
  const left = source.x;
  const top = source.y;
  const right = source.x + source.width;
  const bottom = source.y + source.height;
  const movesLeft = corner.endsWith('left');
  const movesTop = corner.startsWith('top');
  const anchorX = movesLeft ? right : left;
  const anchorY = movesTop ? bottom : top;
  const startX = movesLeft ? left : right;
  const startY = movesTop ? top : bottom;
  const pointerX = startX + gesture.dx / viewport.width;
  const pointerY = startY + gesture.dy / viewport.height;
  const horizontalDirection = movesLeft ? -1 : 1;
  const verticalDirection = movesTop ? -1 : 1;

  if (lockedAspectRatio && Number.isFinite(lockedAspectRatio) && lockedAspectRatio > 0) {
    const normalizedAspect = lockedAspectRatio * viewport.height / viewport.width;
    const requestedWidth = Math.max(0, horizontalDirection * (pointerX - anchorX));
    const requestedHeight = Math.max(0, verticalDirection * (pointerY - anchorY));
    // Project the pointer onto the aspect-ratio line so both axes contribute
    // naturally instead of one axis unexpectedly winning the gesture.
    const projectedHeight = (
      requestedWidth * normalizedAspect + requestedHeight
    ) / (normalizedAspect * normalizedAspect + 1);
    const maximumWidth = movesLeft ? anchorX : 1 - anchorX;
    const maximumHeight = movesTop ? anchorY : 1 - anchorY;
    const minimumHeight = Math.max(minimumSize, minimumSize / normalizedAspect);
    const maximumLockedHeight = Math.min(maximumHeight, maximumWidth / normalizedAspect);
    const height = clamp(projectedHeight, Math.min(minimumHeight, maximumLockedHeight), maximumLockedHeight);
    const width = height * normalizedAspect;

    return {
      x: movesLeft ? anchorX - width : anchorX,
      y: movesTop ? anchorY - height : anchorY,
      width,
      height,
    };
  }

  const nextLeft = movesLeft ? clamp(pointerX, 0, right - minimumSize) : left;
  const nextRight = movesLeft ? right : clamp(pointerX, left + minimumSize, 1);
  const nextTop = movesTop ? clamp(pointerY, 0, bottom - minimumSize) : top;
  const nextBottom = movesTop ? bottom : clamp(pointerY, top + minimumSize, 1);

  return {
    x: nextLeft,
    y: nextTop,
    width: nextRight - nextLeft,
    height: nextBottom - nextTop,
  };
};

const handlePositionStyles: Record<CropCorner, ViewStyle> = {
  'top-left': { left: -24, top: -24 },
  'top-right': { right: -24, top: -24 },
  'bottom-left': { left: -24, bottom: -24 },
  'bottom-right': { right: -24, bottom: -24 },
};

const handleMarkerStyles: Record<CropCorner, ViewStyle> = {
  'top-left': { left: 14, top: 14, borderLeftWidth: 3, borderTopWidth: 3 },
  'top-right': { right: 14, top: 14, borderRightWidth: 3, borderTopWidth: 3 },
  'bottom-left': { left: 14, bottom: 14, borderLeftWidth: 3, borderBottomWidth: 3 },
  'bottom-right': { right: 14, bottom: 14, borderRightWidth: 3, borderBottomWidth: 3 },
};

const handleMarkerShadowStyles: Record<CropCorner, ViewStyle> = {
  'top-left': { left: 12, top: 12, borderLeftWidth: 7, borderTopWidth: 7 },
  'top-right': { right: 12, top: 12, borderRightWidth: 7, borderTopWidth: 7 },
  'bottom-left': { left: 12, bottom: 12, borderLeftWidth: 7, borderBottomWidth: 7 },
  'bottom-right': { right: 12, bottom: 12, borderRightWidth: 7, borderBottomWidth: 7 },
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
  minimumSize = DEFAULT_MINIMUM_SIZE,
  disabled = false,
  showGrid = true,
  style,
  testID,
}: CropOverlayProps) => {
  const viewportRef = useRef<CropViewportSize>({ width: 0, height: 0 });
  const regionRef = useRef(normalizeCropRegion(region, minimumSize));
  const gestureStartRef = useRef(regionRef.current);
  const gestureRegionRef = useRef(regionRef.current);
  const onChangeRef = useRef(onChange);
  const onCommitRef = useRef(onCommit);

  const normalizedRegion = normalizeCropRegion(region, minimumSize);
  regionRef.current = normalizedRegion;
  onChangeRef.current = onChange;
  onCommitRef.current = onCommit;

  const beginGesture = () => {
    const start = normalizeCropRegion(regionRef.current, minimumSize);
    gestureStartRef.current = start;
    gestureRegionRef.current = start;
  };

  const emitChange = (nextRegion: Region) => {
    const next = normalizeCropRegion(nextRegion, minimumSize);
    gestureRegionRef.current = next;
    onChangeRef.current(next);
  };

  const finishGesture = () => {
    onCommitRef.current(gestureRegionRef.current);
  };

  const moveResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !disabled,
    onMoveShouldSetPanResponder: (_event, gesture) => !disabled && (Math.abs(gesture.dx) > 2 || Math.abs(gesture.dy) > 2),
    onPanResponderGrant: beginGesture,
    onPanResponderMove: (_event, gesture) => {
      const viewport = viewportRef.current;
      if (viewport.width <= 0 || viewport.height <= 0) return;
      emitChange(moveRegion(gestureStartRef.current, gesture, viewport));
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
        emitChange(resizeRegion(
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
    const next = resizeRegion(
      normalizedRegion,
      corner,
      gesture,
      viewport,
      clamp(minimumSize, 0.02, 1),
      lockedAspectRatio,
    );
    emitChange(next);
    onCommitRef.current(gestureRegionRef.current);
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
      ...normalizedRegion,
      x: clamp(normalizedRegion.x + offset.dx, 0, 1 - normalizedRegion.width),
      y: clamp(normalizedRegion.y + offset.dy, 0, 1 - normalizedRegion.height),
    };
    emitChange(next);
    onCommitRef.current(gestureRegionRef.current);
  };

  const frameStyle: ViewStyle = {
    left: `${normalizedRegion.x * 100}%`,
    top: `${normalizedRegion.y * 100}%`,
    width: `${normalizedRegion.width * 100}%`,
    height: `${normalizedRegion.height * 100}%`,
  };

  return (
    <View
      testID={testID}
      pointerEvents={disabled ? 'none' : 'box-none'}
      style={[StyleSheet.absoluteFill, style]}
      onLayout={handleLayout}
    >
      <View pointerEvents="none" style={[styles.scrim, { left: 0, right: 0, top: 0, height: `${normalizedRegion.y * 100}%` }]} />
      <View pointerEvents="none" style={[styles.scrim, { left: 0, top: `${normalizedRegion.y * 100}%`, width: `${normalizedRegion.x * 100}%`, height: `${normalizedRegion.height * 100}%` }]} />
      <View pointerEvents="none" style={[styles.scrim, { right: 0, top: `${normalizedRegion.y * 100}%`, width: `${(1 - normalizedRegion.x - normalizedRegion.width) * 100}%`, height: `${normalizedRegion.height * 100}%` }]} />
      <View pointerEvents="none" style={[styles.scrim, { left: 0, right: 0, bottom: 0, height: `${(1 - normalizedRegion.y - normalizedRegion.height) * 100}%` }]} />

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

        {(Object.keys(cornerResponders) as CropCorner[]).map((corner) => (
          <View
            key={corner}
            accessibilityRole="adjustable"
            accessibilityLabel={cornerLabels[corner]}
            accessibilityHint="Drag to resize the crop. Swipe up or down with a screen reader to resize."
            accessibilityState={{ disabled }}
            accessibilityActions={[{ name: 'increment', label: 'Expand crop' }, { name: 'decrement', label: 'Reduce crop' }]}
            style={[styles.handle, handlePositionStyles[corner]]}
            onAccessibilityAction={(event) => adjustCornerWithAccessibility(corner, event)}
            {...cornerResponders[corner].panHandlers}
          >
            <View pointerEvents="none" style={[styles.handleMarkerShadow, handleMarkerShadowStyles[corner]]} />
            <View pointerEvents="none" style={[styles.handleMarker, handleMarkerStyles[corner]]} />
          </View>
        ))}
      </View>
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
