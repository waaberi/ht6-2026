import { MaterialCommunityIcons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import {
  type CameraType,
  CameraView,
  type FlashMode,
  useCameraPermissions,
} from 'expo-camera';
import { DeviceMotion } from 'expo-sensors';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Linking,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '../components/theme';
import { captureControlsForSession, clampZoom, horizonRollForOrientation, normalizeFlashMode, zoomFromPinch } from '../domain/cameraControls';
import {
  defaultPreferences,
  loadPreferences,
  type CameraPreferences,
  updateCameraPreferences,
} from '../data/preferences';
import { supabase } from '../services/supabase';
import { persistPreferences as persistPreferencesToCloud } from '../services/sync';
import { useExposure } from '../state/ExposureContext';

type CameraScreenProps = {
  onOpenStudio: () => void;
  onOpenLibrary: () => void;
};

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

const timerOptions = [0, 3, 10] as const;
const ratioOptions: CameraPreferences['photoRatio'][] = ['4:3', '16:9'];
const distanceBetweenTouches = (touches: ReadonlyArray<{ pageX: number; pageY: number }>) => {
  if (touches.length < 2) return 0;
  return Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY);
};

const nextValue = <T,>(options: readonly T[], current: T) =>
  options[(options.indexOf(current) + 1) % options.length];

const pictureSizeForRatio = (sizes: string[], ratio: CameraPreferences['photoRatio']) => {
  const target = ratio === '16:9' ? 16 / 9 : 4 / 3;
  return sizes
    .map((size) => {
      const [width, height] = size.split('x').map(Number);
      return { size, width, height, distance: Math.abs(width / height - target) };
    })
    .filter(({ width, height }) => Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)
    .sort((left, right) => left.distance - right.distance || right.width * right.height - left.width * left.height)
    .find(({ distance }) => distance < 0.04)?.size;
};

export const CameraScreen = ({ onOpenStudio, onOpenLibrary }: CameraScreenProps) => {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const busyRef = useRef(false);
  const preferencesRef = useRef<CameraPreferences>(defaultPreferences.camera);
  const zoomRef = useRef(defaultPreferences.camera.zoom);
  const pinchRef = useRef({ distance: 0, zoom: 0 });
  const [facing, setFacing] = useState<CameraType>('back');
  const [cameraPreferences, setCameraPreferences] = useState<CameraPreferences>(defaultPreferences.camera);
  const [availablePictureSizes, setAvailablePictureSizes] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [countdown, setCountdown] = useState<number>();
  const [controlsOpen, setControlsOpen] = useState(false);
  const [flashSettling, setFlashSettling] = useState(true);
  const [levelRoll, setLevelRoll] = useState<number>();
  const [error, setError] = useState<string>();
  const { ingest, selectedPhoto } = useExposure();

  useEffect(() => {
    void loadPreferences().then(({ camera: saved }) => {
      const sessionControls = captureControlsForSession(saved, defaultPreferences.camera);
      const next = { ...saved, ...sessionControls };
      preferencesRef.current = next;
      zoomRef.current = next.zoom;
      setCameraPreferences(next);
    });
  }, []);

  const pictureSize = useMemo(
    () => pictureSizeForRatio(availablePictureSizes, cameraPreferences.photoRatio),
    [availablePictureSizes, cameraPreferences.photoRatio],
  );

  const persistCamera = useCallback(async (changes: Partial<CameraPreferences>) => {
    await updateCameraPreferences(changes);
    if (!supabase) return;
    const { data } = await supabase.auth.getSession();
    if (data.session) await persistPreferencesToCloud(await loadPreferences());
  }, []);

  const updateCamera = useCallback((changes: Partial<CameraPreferences>) => {
    setCameraPreferences((current) => {
      const next = { ...current, ...changes };
      preferencesRef.current = next;
      if (changes.zoom !== undefined) zoomRef.current = changes.zoom;
      if (current.preserveCaptureSettings) {
        void persistCamera(changes).catch(() => undefined);
      }
      return next;
    });
  }, [persistCamera]);

  const updateZoom = useCallback((zoom: number) => {
    const nextZoom = clampZoom(zoom);
    zoomRef.current = nextZoom;
    setCameraPreferences((current) => {
      const next = { ...current, zoom: nextZoom };
      preferencesRef.current = next;
      return next;
    });
  }, []);

  const finishZoom = useCallback((zoom: number) => {
    const nextZoom = clampZoom(zoom);
    updateZoom(nextZoom);
    if (preferencesRef.current.preserveCaptureSettings) {
      void persistCamera({ zoom: nextZoom }).catch(() => undefined);
    }
  }, [persistCamera, updateZoom]);

  useEffect(() => {
    setLevelRoll(undefined);
    if (!cameraPreferences.showLevel) return;
    let subscription: ReturnType<typeof DeviceMotion.addListener> | undefined;
    let cancelled = false;
    void (async () => {
      const [available, permission] = await Promise.all([
        DeviceMotion.isAvailableAsync(),
        DeviceMotion.getPermissionsAsync(),
      ]);
      if (cancelled || !available || !permission.granted) return;
      DeviceMotion.setUpdateInterval(100);
      subscription = DeviceMotion.addListener((measurement) => {
        const next = horizonRollForOrientation(measurement.rotation, measurement.orientation);
        setLevelRoll((current) => current === undefined ? next : current * 0.72 + next * 0.28);
      });
    })().catch(() => setLevelRoll(undefined));
    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [cameraPreferences.showLevel]);

  useEffect(() => {
    setFlashSettling(true);
    const timeout = setTimeout(() => setFlashSettling(false), 120);
    return () => clearTimeout(timeout);
  }, [cameraPreferences.defaultFlash, facing]);

  const pinchResponder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: (event) => event.nativeEvent.touches.length === 2,
    onMoveShouldSetPanResponder: (event) => event.nativeEvent.touches.length === 2,
    onPanResponderGrant: (event) => {
      pinchRef.current = {
        distance: distanceBetweenTouches(event.nativeEvent.touches),
        zoom: zoomRef.current,
      };
    },
    onPanResponderMove: (event) => {
      const distance = distanceBetweenTouches(event.nativeEvent.touches);
      const start = pinchRef.current;
      if (!distance || !start.distance) return;
      updateZoom(zoomFromPinch(start.zoom, start.distance, distance));
    },
    onPanResponderRelease: () => finishZoom(zoomRef.current),
    onPanResponderTerminate: () => finishZoom(zoomRef.current),
  }), [finishZoom, updateZoom]);

  const run = async (work: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'The photo could not be saved.');
    } finally {
      busyRef.current = false;
      setBusy(false);
      setCountdown(undefined);
    }
  };

  const waitForTimer = async () => {
    for (let remaining = cameraPreferences.timerSeconds; remaining > 0; remaining -= 1) {
      setCountdown(remaining);
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
    }
  };

  const capture = () => run(async () => {
    if (!camera.current || !ready || flashSettling) throw new Error('Camera controls are still updating.');
    await waitForTimer();
    const picture = await camera.current.takePictureAsync({ quality: 1, exif: true, skipProcessing: false });
    await ingest({
      uri: picture.uri,
      name: `Exposure-${Date.now()}.${picture.format}`,
      mimeType: picture.format === 'png' ? 'image/png' : 'image/jpeg',
      source: 'camera',
      width: picture.width,
      height: picture.height,
      exif: picture.exif ?? {},
    });
    if (!preferencesRef.current.preserveCaptureSettings) {
      updateCamera({
        defaultFlash: defaultPreferences.camera.defaultFlash,
        timerSeconds: defaultPreferences.camera.timerSeconds,
        photoRatio: defaultPreferences.camera.photoRatio,
        zoom: defaultPreferences.camera.zoom,
      });
    }
  });

  const onCameraReady = async () => {
    setReady(true);
    if (Platform.OS !== 'ios' || !camera.current) return;
    try {
      setAvailablePictureSizes(await camera.current.getAvailablePictureSizesAsync());
    } catch {
      setAvailablePictureSizes([]);
    }
  };

  const switchCamera = () => {
    setReady(false);
    setAvailablePictureSizes([]);
    setFacing((current) => (current === 'back' ? 'front' : 'back'));
  };

  const openRecent = () => {
    if (selectedPhoto) onOpenStudio();
    else onOpenLibrary();
  };

  if (!permission) return <View style={styles.screen} />;
  if (!permission.granted) {
    const canRequest = permission.canAskAgain;
    return (
      <View style={[styles.permission, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
        <MaterialCommunityIcons name="camera-outline" size={42} color={colors.lime} />
        <Text style={styles.permissionTitle}>Camera access</Text>
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
          onPress={canRequest ? requestPermission : Linking.openSettings}
        >
          <Text style={styles.primaryButtonText}>{canRequest ? 'Allow camera' : 'Open settings'}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          style={({ pressed }) => [styles.secondaryButton, pressed && styles.pressed]}
          onPress={onOpenLibrary}
        >
          <Text style={styles.secondaryButtonText}>Open Library</Text>
        </Pressable>
      </View>
    );
  }

  const flash = normalizeFlashMode(cameraPreferences.defaultFlash) as FlashMode;
  const panelBottomPadding = 12;
  const guideBottom = controlsOpen ? 254 : 178;
  const levelAligned = levelRoll !== undefined && Math.abs(levelRoll) <= Math.PI / 120;
  const levelColor = levelAligned ? colors.success : colors.primary;

  return (
    <View style={styles.screen}>
      <CameraView
        ref={camera}
        accessible={false}
        style={StyleSheet.absoluteFill}
        facing={facing}
        flash={flash}
        mirror={facing === 'front' && cameraPreferences.mirrorSelfies}
        mode="picture"
        zoom={cameraPreferences.zoom}
        enableTorch={false}
        animateShutter={false}
        ratio={Platform.OS === 'android' ? cameraPreferences.photoRatio : undefined}
        pictureSize={Platform.OS === 'ios' ? pictureSize : undefined}
        responsiveOrientationWhenOrientationLocked={Platform.OS === 'ios' ? true : undefined}
        onCameraReady={onCameraReady}
        onMountError={(event) => setError(event.message)}
      />

      <View
        accessible={false}
        style={[styles.pinchTarget, { top: insets.top, bottom: guideBottom }]}
        {...pinchResponder.panHandlers}
      />

      <View pointerEvents="none" style={[styles.guides, { bottom: guideBottom, top: insets.top }]}>
        {cameraPreferences.showGrid ? (
          <>
            <View style={[styles.verticalLine, { left: '33.33%' }]} />
            <View style={[styles.verticalLine, { left: '66.66%' }]} />
            <View style={[styles.horizontalLine, { top: '33.33%' }]} />
            <View style={[styles.horizontalLine, { top: '66.66%' }]} />
          </>
        ) : null}
        {cameraPreferences.showLevel && levelRoll !== undefined ? (
          <View style={[styles.levelGuide, { transform: [{ rotate: `${levelRoll}rad` }] }]}>
            <View style={[styles.levelLine, { backgroundColor: levelColor }]} />
            <View style={[styles.levelMark, { borderColor: levelColor }]} />
            <View style={[styles.levelLine, { backgroundColor: levelColor }]} />
          </View>
        ) : null}
      </View>

      {countdown ? (
        <View pointerEvents="none" style={styles.countdown}>
          <Text accessibilityLiveRegion="assertive" style={styles.countdownText}>{countdown}</Text>
        </View>
      ) : null}

      <View style={[styles.bottomPanel, { paddingBottom: panelBottomPadding }]}>
        {error ? <Text accessibilityLiveRegion="polite" numberOfLines={2} style={styles.error}>{error}</Text> : null}

        <View style={styles.zoomRow}>
          <MaterialCommunityIcons name="magnify-minus-outline" size={20} color={colors.muted} />
          <Slider
            style={styles.zoomSlider}
            minimumValue={0}
            maximumValue={1}
            step={0.01}
            value={cameraPreferences.zoom}
            minimumTrackTintColor={colors.lime}
            maximumTrackTintColor={colors.line}
            thumbTintColor={colors.ink}
            onValueChange={updateZoom}
            onSlidingComplete={finishZoom}
            accessibilityLabel="Zoom"
            accessibilityValue={{ min: 0, max: 100, now: Math.round(cameraPreferences.zoom * 100) }}
          />
          <MaterialCommunityIcons name="magnify-plus-outline" size={20} color={colors.ink} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={controlsOpen ? 'Hide camera controls' : 'Show camera controls'}
            style={({ pressed }) => [styles.trayButton, controlsOpen && styles.trayButtonActive, pressed && styles.pressed]}
            onPress={() => setControlsOpen((open) => !open)}
          >
            <MaterialCommunityIcons name={controlsOpen ? 'chevron-down' : 'tune-variant'} size={24} color={controlsOpen ? colors.limeInk : colors.ink} />
          </Pressable>
        </View>

        {controlsOpen ? (
          <View style={styles.controlTray}>
            <View style={styles.controlRow}>
              <ControlButton
                icon={flash === 'off' ? 'flash-off' : flash === 'auto' ? 'flash-auto' : 'flash'}
                label={flash === 'off' ? 'Flash off' : flash === 'auto' ? 'Flash auto' : 'Flash on'}
                onPress={() => {
                  setFlashSettling(true);
                  updateCamera({ defaultFlash: nextValue(['off', 'auto', 'on'] as const, flash) });
                }}
              />
              <ControlButton
                icon="timer-outline"
                label={cameraPreferences.timerSeconds ? `${cameraPreferences.timerSeconds}s` : 'Timer off'}
                onPress={() => updateCamera({ timerSeconds: nextValue(timerOptions, cameraPreferences.timerSeconds) })}
              />
              <ControlButton
                icon="aspect-ratio"
                label={cameraPreferences.photoRatio}
                onPress={() => updateCamera({ photoRatio: nextValue(ratioOptions, cameraPreferences.photoRatio) })}
              />
            </View>
          </View>
        ) : null}

        <View style={styles.captureRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={selectedPhoto ? 'Open recent photo' : 'Open Library'}
            style={({ pressed }) => [styles.recentButton, pressed && styles.pressed]}
            onPress={openRecent}
            disabled={busy}
          >
            {selectedPhoto ? (
              <Image source={{ uri: selectedPhoto.thumbnailUri }} style={styles.recentImage} />
            ) : (
              <MaterialCommunityIcons name="image-outline" size={26} color={colors.ink} />
            )}
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={cameraPreferences.timerSeconds ? `Take photo with ${cameraPreferences.timerSeconds} second timer` : 'Take photo'}
            style={({ pressed }) => [styles.shutter, (!ready || busy || flashSettling) && styles.disabled, pressed && styles.pressed]}
            onPress={capture}
            disabled={!ready || busy || flashSettling}
          >
            {busy && !countdown ? <ActivityIndicator color={colors.ink} /> : <View style={styles.shutterCore} />}
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel={facing === 'back' ? 'Switch to front camera' : 'Switch to rear camera'}
            style={({ pressed }) => [styles.flipButton, pressed && styles.pressed]}
            onPress={switchCamera}
            disabled={busy}
          >
            <MaterialCommunityIcons name="camera-switch-outline" size={30} color={colors.ink} />
          </Pressable>
        </View>
      </View>
    </View>
  );
};

const ControlButton = ({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) => (
  <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    style={({ pressed }) => [styles.controlButton, pressed && styles.pressed]}
    onPress={onPress}
  >
    <MaterialCommunityIcons name={icon} size={22} color={colors.ink} />
    <Text numberOfLines={1} style={styles.controlLabel}>{label}</Text>
  </Pressable>
);

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  pinchTarget: { position: 'absolute', left: 0, right: 0 },
  guides: { position: 'absolute', left: 0, right: 0 },
  verticalLine: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(234,189,168,0.46)' },
  horizontalLine: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(234,189,168,0.46)' },
  levelGuide: { position: 'absolute', left: '28%', right: '28%', top: '50%', flexDirection: 'row', alignItems: 'center', gap: 5 },
  levelLine: { flex: 1, height: 2, borderRadius: 1 },
  levelMark: { width: 7, height: 7, borderRadius: 4, borderWidth: 2 },
  countdown: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(34,26,27,0.2)' },
  countdownText: { color: colors.ink, fontSize: 76, fontWeight: '300' },
  bottomPanel: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 8, backgroundColor: colors.background },
  error: { color: colors.danger, textAlign: 'center', fontSize: 13, lineHeight: 18, marginBottom: 6 },
  zoomRow: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: 7 },
  zoomSlider: { flex: 1, height: 40 },
  trayButton: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceStrong },
  trayButtonActive: { backgroundColor: colors.lime },
  controlTray: { gap: 8, paddingBottom: 8 },
  controlRow: { flexDirection: 'row', gap: 6 },
  controlButton: { flex: 1, minHeight: 60, minWidth: 0, borderRadius: 10, backgroundColor: colors.surfaceStrong, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 2, gap: 4 },
  controlLabel: { color: colors.ink, fontSize: 11, textAlign: 'center' },
  captureRow: { minHeight: 100, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6 },
  recentButton: { width: 58, height: 58, borderRadius: 12, overflow: 'hidden', borderWidth: 2, borderColor: colors.text, backgroundColor: colors.surfaceStrong, alignItems: 'center', justifyContent: 'center' },
  recentImage: { width: '100%', height: '100%' },
  shutter: { width: 82, height: 82, borderRadius: 41, borderWidth: 3, borderColor: colors.ink, padding: 6, alignItems: 'center', justifyContent: 'center' },
  shutterCore: { width: '100%', height: '100%', borderRadius: 34, backgroundColor: colors.ink },
  flipButton: { width: 58, height: 58, borderRadius: 29, backgroundColor: colors.surfaceStrong, alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },
  permission: { flex: 1, paddingHorizontal: 28, backgroundColor: colors.canvas, justifyContent: 'center' },
  permissionTitle: { color: colors.ink, fontFamily: 'ZenOldMincho_700Bold', fontSize: 30, lineHeight: 38, marginTop: 22 },
  primaryButton: { backgroundColor: colors.lime, minHeight: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 12, marginTop: 24 },
  primaryButtonText: { color: colors.limeInk, fontWeight: '800', fontSize: 15 },
  secondaryButton: { minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: 4 },
  secondaryButtonText: { color: colors.ink, fontWeight: '700', fontSize: 14 },
});
