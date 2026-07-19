export type MotionRotation = { beta: number; gamma: number };
export type CaptureFlashMode = 'off' | 'auto' | 'on';
export type CaptureSessionControls = {
  defaultFlash: CaptureFlashMode;
  timerSeconds: 0 | 3 | 10;
  photoRatio: '4:3' | '16:9';
  zoom: number;
  preserveCaptureSettings: boolean;
};
export type PhotoRatio = CaptureSessionControls['photoRatio'];
export type CapturePlatform = 'android' | 'ios';

export const highestQualityCaptureOptions = {
  quality: 1,
  exif: true,
  skipProcessing: false,
} as const;

const parsedPictureSize = (size: string) => {
  const match = /^(\d+)x(\d+)$/i.exec(size.trim());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return { size, width, height };
};

/** Selects the highest-resolution format advertised by the active native camera. */
export const highestQualityPictureSize = (
  sizes: readonly string[],
  ratio: PhotoRatio,
  platform: CapturePlatform,
) => {
  // iOS mixes symbolic AVCaptureSession presets with numeric video formats.
  // `Photo` is its full-resolution still preset; ignoring it makes the 4:3
  // path incorrectly select 640x480 as the best numeric match.
  if (platform === 'ios' && ratio === '4:3') {
    const photoPreset = sizes.find((size) => size.toLowerCase() === 'photo');
    if (photoPreset) return photoPreset;
  }

  const target = ratio === '16:9' ? 16 / 9 : 4 / 3;
  const selected = sizes
    .map(parsedPictureSize)
    .filter((size): size is NonNullable<typeof size> => Boolean(size))
    .map((size) => ({ ...size, distance: Math.abs(size.width / size.height - target) }))
    .filter(({ distance }) => distance < 0.04)
    .sort((left, right) => right.width * right.height - left.width * left.height)[0];

  if (selected) return selected.size;
  if (platform === 'ios') {
    return sizes.find((size) => size.toLowerCase() === 'high')
      ?? sizes.find((size) => size.toLowerCase() === 'photo');
  }

  // Undefined preserves CameraX's highest-available strategy constrained by
  // the requested ratio when an OEM reports no exact matching size.
  return undefined;
};

export const normalizeFlashMode = (value: unknown): CaptureFlashMode =>
  value === 'on' || value === 'auto' ? value : 'off';

export const clampZoom = (zoom: number) => Math.max(0, Math.min(1, zoom));

export const captureControlsForSession = (
  saved: CaptureSessionControls,
  defaults: CaptureSessionControls,
): CaptureSessionControls => saved.preserveCaptureSettings
  ? { ...saved, defaultFlash: normalizeFlashMode(saved.defaultFlash), zoom: clampZoom(saved.zoom) }
  : {
      ...saved,
      defaultFlash: defaults.defaultFlash,
      timerSeconds: defaults.timerSeconds,
      photoRatio: defaults.photoRatio,
      zoom: defaults.zoom,
    };

export const zoomFromPinch = (
  startZoom: number,
  startDistance: number,
  currentDistance: number,
) => {
  if (startDistance <= 0 || currentDistance <= 0) return clampZoom(startZoom);
  return clampZoom(startZoom + Math.log2(currentDistance / startDistance) * 0.22);
};

export const horizonRollForOrientation = (
  rotation: MotionRotation | null | undefined,
  orientation: number,
) => {
  if (!rotation) return 0;
  switch (orientation) {
    case 90:
      return rotation.beta;
    case -90:
      return -rotation.beta;
    case 180:
      return -rotation.gamma;
    default:
      return rotation.gamma;
  }
};
