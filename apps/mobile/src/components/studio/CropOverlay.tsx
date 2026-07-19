import React, { useEffect, useMemo, useRef } from 'react';
import {
  type AccessibilityActionEvent,
  type LayoutChangeEvent,
  PanResponder,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';

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
const FRAME_WIDTH = 3;
const FRAME_HIGHLIGHT_WIDTH = 1;

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

type CropAnimationValues = {
  region: SharedValue<Region>;
  viewport: SharedValue<CropViewportSize>;
};

type CropSide = 'top' | 'right' | 'bottom' | 'left';

const transformMatrix = (
  scaleX: number,
  scaleY: number,
  translateX: number,
  translateY: number,
) => {
  'worklet';
  return [
    scaleX, 0, 0, 0,
    0, scaleY, 0, 0,
    0, 0, 1, 0,
    translateX, translateY, 0, 1,
  ];
};

/** A full-viewport rectangle transformed into one side of the crop scrim. */
const CropScrim = ({ side, region, viewport }: CropAnimationValues & { side: CropSide }) => {
  const animatedStyle = useAnimatedStyle(() => {
    const crop = region.value;
    const size = viewport.value;

    if (side === 'top') {
      return { transform: [{ matrix: transformMatrix(1, crop.y, 0, 0) }] };
    }
    if (side === 'bottom') {
      return {
        transform: [{
          matrix: transformMatrix(
            1,
            Math.max(0, 1 - crop.y - crop.height),
            0,
            (crop.y + crop.height) * size.height,
          ),
        }],
      };
    }
    if (side === 'left') {
      return {
        transform: [{ matrix: transformMatrix(crop.x, crop.height, 0, crop.y * size.height) }],
      };
    }
    return {
      transform: [{
        matrix: transformMatrix(
          Math.max(0, 1 - crop.x - crop.width),
          crop.height,
          (crop.x + crop.width) * size.width,
          crop.y * size.height,
        ),
      }],
    };
  });

  return <Animated.View pointerEvents="none" style={[styles.scrim, animatedStyle]} />;
};

/** Crop boundary line whose thickness stays constant while its length changes. */
const CropBoundary = ({
  side,
  region,
  viewport,
  highlight = false,
}: CropAnimationValues & { side: CropSide; highlight?: boolean }) => {
  const thickness = highlight ? FRAME_HIGHLIGHT_WIDTH : FRAME_WIDTH;
  const horizontal = side === 'top' || side === 'bottom';
  const animatedStyle = useAnimatedStyle(() => {
    const crop = region.value;
    const size = viewport.value;
    const cropRight = (crop.x + crop.width) * size.width;
    const cropBottom = (crop.y + crop.height) * size.height;
    const translateX = side === 'right' ? cropRight - thickness : crop.x * size.width;
    const translateY = side === 'bottom' ? cropBottom - thickness : crop.y * size.height;

    return {
      transform: [{
        matrix: transformMatrix(
          horizontal ? crop.width : 1,
          horizontal ? 1 : crop.height,
          translateX,
          translateY,
        ),
      }],
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        horizontal ? styles.horizontalBoundary : styles.verticalBoundary,
        highlight ? styles.frameHighlight : styles.frameBoundary,
        { width: horizontal ? undefined : thickness, height: horizontal ? thickness : undefined },
        animatedStyle,
      ]}
    />
  );
};

const CropGuide = ({
  orientation,
  fraction,
  region,
  viewport,
}: CropAnimationValues & { orientation: 'horizontal' | 'vertical'; fraction: number }) => {
  const horizontal = orientation === 'horizontal';
  const animatedStyle = useAnimatedStyle(() => {
    const crop = region.value;
    const size = viewport.value;
    const translateX = (crop.x + (horizontal ? 0 : crop.width * fraction)) * size.width;
    const translateY = (crop.y + (horizontal ? crop.height * fraction : 0)) * size.height;
    return {
      transform: [{
        matrix: transformMatrix(
          horizontal ? crop.width : 1,
          horizontal ? 1 : crop.height,
          translateX,
          translateY,
        ),
      }],
    };
  });

  return (
    <Animated.View
      pointerEvents="none"
      style={[horizontal ? styles.horizontalGuide : styles.verticalGuide, animatedStyle]}
    />
  );
};

const CropHandle = ({
  corner,
  region,
  viewport,
  disabled,
  responder,
  onAccessibilityAction,
}: CropAnimationValues & {
  corner: CropCorner;
  disabled: boolean;
  responder: ReturnType<typeof PanResponder.create>;
  onAccessibilityAction: (event: AccessibilityActionEvent) => void;
}) => {
  const animatedStyle = useAnimatedStyle(() => {
    const crop = region.value;
    const size = viewport.value;
    const movesLeft = corner.endsWith('left');
    const movesTop = corner.startsWith('top');
    const translateX = (crop.x + (movesLeft ? 0 : crop.width)) * size.width
      - (movesLeft ? 0 : appLayout.minTouchTarget);
    const translateY = (crop.y + (movesTop ? 0 : crop.height)) * size.height
      - (movesTop ? 0 : appLayout.minTouchTarget);
    return { transform: [{ translateX }, { translateY }] };
  });

  return (
    <Animated.View
      accessibilityRole="adjustable"
      accessibilityLabel={cornerLabels[corner]}
      accessibilityHint="Drag to resize the crop. Swipe up or down with a screen reader to resize."
      accessibilityState={{ disabled }}
      accessibilityActions={[{ name: 'increment', label: 'Expand crop' }, { name: 'decrement', label: 'Reduce crop' }]}
      style={[styles.handle, animatedStyle]}
      onAccessibilityAction={onAccessibilityAction}
      {...responder.panHandlers}
    >
      <View pointerEvents="none" style={[styles.handleMarkerShadow, handleMarkerShadowStyles[corner]]} />
      <View pointerEvents="none" style={[styles.handleMarker, handleMarkerStyles[corner]]} />
    </Animated.View>
  );
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
  const animatedRegion = useSharedValue(regionRef.current);
  const animatedViewport = useSharedValue<CropViewportSize>({ width: 1, height: 1 });

  const normalizedRegion = normalizeCropRegion(region, minimumSize);
  onChangeRef.current = onChange;
  onCommitRef.current = onCommit;

  useEffect(() => {
    if (gestureActiveRef.current) return;
    regionRef.current = normalizedRegion;
    gestureRegionRef.current = normalizedRegion;
    animatedRegion.value = normalizedRegion;
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
      animatedRegion.value = gestureRegionRef.current;
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
    animatedRegion.value = next;
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
    animatedViewport.value = viewportRef.current;
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
      regionRef.current,
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
      ...regionRef.current,
      x: clamp(regionRef.current.x + offset.dx, 0, 1 - regionRef.current.width),
      y: clamp(regionRef.current.y + offset.dy, 0, 1 - regionRef.current.height),
    };
    gestureRegionRef.current = next;
    finishGesture();
  };

  const frameHitboxStyle = useAnimatedStyle(() => {
    const crop = animatedRegion.value;
    const size = animatedViewport.value;
    return {
      transform: [{
        matrix: transformMatrix(
          crop.width,
          crop.height,
          crop.x * size.width,
          crop.y * size.height,
        ),
      }],
    };
  });

  return (
    <View
      testID={testID}
      pointerEvents={disabled ? 'none' : 'box-none'}
      style={[StyleSheet.absoluteFill, style]}
      onLayout={handleLayout}
    >
      <CropScrim side="top" region={animatedRegion} viewport={animatedViewport} />
      <CropScrim side="left" region={animatedRegion} viewport={animatedViewport} />
      <CropScrim side="right" region={animatedRegion} viewport={animatedViewport} />
      <CropScrim side="bottom" region={animatedRegion} viewport={animatedViewport} />

      <CropBoundary side="top" region={animatedRegion} viewport={animatedViewport} />
      <CropBoundary side="right" region={animatedRegion} viewport={animatedViewport} />
      <CropBoundary side="bottom" region={animatedRegion} viewport={animatedViewport} />
      <CropBoundary side="left" region={animatedRegion} viewport={animatedViewport} />
      <CropBoundary highlight side="top" region={animatedRegion} viewport={animatedViewport} />
      <CropBoundary highlight side="right" region={animatedRegion} viewport={animatedViewport} />
      <CropBoundary highlight side="bottom" region={animatedRegion} viewport={animatedViewport} />
      <CropBoundary highlight side="left" region={animatedRegion} viewport={animatedViewport} />

      {showGrid ? (
        <>
          <CropGuide orientation="vertical" fraction={1 / 3} region={animatedRegion} viewport={animatedViewport} />
          <CropGuide orientation="vertical" fraction={2 / 3} region={animatedRegion} viewport={animatedViewport} />
          <CropGuide orientation="horizontal" fraction={1 / 3} region={animatedRegion} viewport={animatedViewport} />
          <CropGuide orientation="horizontal" fraction={2 / 3} region={animatedRegion} viewport={animatedViewport} />
        </>
      ) : null}

      <Animated.View
        collapsable={false}
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
        style={[styles.frameHitbox, frameHitboxStyle]}
        onAccessibilityAction={moveFrameWithAccessibility}
        {...moveResponder.panHandlers}
      />

      {(Object.keys(cornerResponders) as CropCorner[]).map((corner) => (
        <CropHandle
          key={corner}
          corner={corner}
          region={animatedRegion}
          viewport={animatedViewport}
          disabled={disabled}
          responder={cornerResponders[corner]}
          onAccessibilityAction={(event) => adjustCornerWithAccessibility(corner, event)}
        />
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  scrim: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: colors.overlay,
    transformOrigin: [0, 0, 0],
  },
  frameHitbox: {
    ...StyleSheet.absoluteFillObject,
    transformOrigin: [0, 0, 0],
  },
  horizontalBoundary: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    transformOrigin: [0, 0, 0],
  },
  verticalBoundary: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    transformOrigin: [0, 0, 0],
  },
  frameBoundary: {
    backgroundColor: 'rgba(34,26,27,0.82)',
  },
  frameHighlight: {
    backgroundColor: colors.text,
  },
  verticalGuide: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: StyleSheet.hairlineWidth,
    backgroundColor: colors.text,
    opacity: 0.72,
    transformOrigin: [0, 0, 0],
  },
  horizontalGuide: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.text,
    opacity: 0.72,
    transformOrigin: [0, 0, 0],
  },
  handle: {
    position: 'absolute',
    left: 0,
    top: 0,
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
