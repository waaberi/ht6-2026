export type MotionRotation = { beta: number; gamma: number };
export type CaptureFlashMode = 'off' | 'auto' | 'on';

export const normalizeFlashMode = (value: unknown): CaptureFlashMode =>
  value === 'on' || value === 'auto' ? value : 'off';

export const clampZoom = (zoom: number) => Math.max(0, Math.min(1, zoom));

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
