import type { CanvasTransform, Region } from './types';

const IDENTITY_PERSPECTIVE: CanvasTransform['perspective'] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const straightenDegrees = (rotationDegrees: number) => {
  const quarterTurn = Math.round(rotationDegrees / 90) * 90;
  return rotationDegrees - quarterTurn;
};

export const withStraighten = (transform: CanvasTransform, degrees: number): CanvasTransform => {
  const quarterTurn = Math.round(transform.rotationDegrees / 90) * 90;
  return { ...transform, rotationDegrees: quarterTurn + Math.max(-15, Math.min(15, degrees)) };
};

export const rotateClockwise = (transform: CanvasTransform): CanvasTransform => ({
  ...transform,
  rotationDegrees: ((transform.rotationDegrees + 90) % 360 + 360) % 360,
});

export const centeredCrop = (width: number | undefined, height: number | undefined, aspect: number): Region => {
  const imageWidth = Math.max(1, width ?? 1);
  const imageHeight = Math.max(1, height ?? 1);
  const imageAspect = imageWidth / imageHeight;
  const requestedAspect = imageAspect < 1 && aspect !== 1 ? 1 / aspect : aspect;

  if (imageAspect > requestedAspect) {
    const cropWidth = requestedAspect / imageAspect;
    return { x: (1 - cropWidth) / 2, y: 0, width: cropWidth, height: 1 };
  }
  const cropHeight = imageAspect / requestedAspect;
  return { x: 0, y: (1 - cropHeight) / 2, width: 1, height: cropHeight };
};

export const restoreManualTransform = (transform: CanvasTransform): CanvasTransform => ({
  rotationDegrees: 0,
  perspective: [...IDENTITY_PERSPECTIVE],
  ...(transform.expansion ? { expansion: { ...transform.expansion } } : {}),
});

export const hasManualTransform = (transform: CanvasTransform) => (
  Boolean(transform.crop)
  || Math.abs(transform.rotationDegrees) > 0.001
  || transform.perspective.some((value, index) => value !== IDENTITY_PERSPECTIVE[index])
);
