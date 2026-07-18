import type { CanvasExpansion, CanvasTransform, Region } from './types';

const IDENTITY_PERSPECTIVE: CanvasTransform['perspective'] = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const ROTATION_ADJUSTMENT_LIMIT = 45;
const ROTATION_BOUNDARY_EPSILON = 1e-6;

/**
 * Returns the orientation quarter-turn encoded in a combined rotation value.
 * Half-turn boundaries stay with the current orientation so a +45 degree
 * manual rotation does not unexpectedly swap the crop canvas dimensions.
 */
export const quarterTurnsForRotation = (rotationDegrees: number) => {
  if (!Number.isFinite(rotationDegrees)) return 0;
  const turns = rotationDegrees / 90;
  const nearest = Math.round(turns);
  return Math.abs(Math.abs(turns - nearest) - 0.5) < 1e-9 ? Math.trunc(turns) : nearest;
};

export const straightenDegrees = (rotationDegrees: number) => {
  const quarterTurn = quarterTurnsForRotation(rotationDegrees) * 90;
  return rotationDegrees - quarterTurn;
};

export const withRotationAdjustment = (transform: CanvasTransform, degrees: number): CanvasTransform => {
  const quarterTurn = quarterTurnsForRotation(transform.rotationDegrees) * 90;
  const finiteDegrees = Number.isFinite(degrees) ? degrees : 0;
  const clamped = Math.max(-ROTATION_ADJUSTMENT_LIMIT, Math.min(ROTATION_ADJUSTMENT_LIMIT, finiteDegrees));
  // Keep the combined value on the intended side of the ambiguous 45-degree
  // boundary so a quarter-turned image retains its orientation at the limit.
  const bounded = Math.abs(clamped) === ROTATION_ADJUSTMENT_LIMIT
    ? clamped - Math.sign(clamped) * ROTATION_BOUNDARY_EPSILON
    : clamped;
  return {
    ...transform,
    rotationDegrees: quarterTurn + bounded,
  };
};

/** Backwards-compatible name for existing callers. */
export const withStraighten = withRotationAdjustment;

const cleanUnitValue = (value: number) => (
  Number(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)).toFixed(12))
);

export const rotateCropClockwise = (crop: Region): Region => {
  const x = cleanUnitValue(crop.x);
  const y = cleanUnitValue(crop.y);
  const width = cleanUnitValue(Math.min(crop.width, 1 - x));
  const height = cleanUnitValue(Math.min(crop.height, 1 - y));
  return {
    x: cleanUnitValue(1 - (y + height)),
    y: x,
    width: height,
    height: width,
  };
};

export const rotateClockwise = (transform: CanvasTransform): CanvasTransform => ({
  ...transform,
  rotationDegrees: ((transform.rotationDegrees + 90) % 360 + 360) % 360,
  ...(transform.crop ? { crop: rotateCropClockwise(transform.crop) } : {}),
});

export const visibleRotatedCanvasSize = (
  width: number | undefined,
  height: number | undefined,
  rotationDegrees = 0,
) => {
  const imageWidth = Math.max(1, width ?? 1);
  const imageHeight = Math.max(1, height ?? 1);
  const swapsDimensions = Math.abs(quarterTurnsForRotation(rotationDegrees)) % 2 === 1;
  return swapsDimensions
    ? { width: imageHeight, height: imageWidth }
    : { width: imageWidth, height: imageHeight };
};

export const centeredCrop = (
  width: number | undefined,
  height: number | undefined,
  aspect: number,
  rotationDegrees = 0,
): Region => {
  const canvas = visibleRotatedCanvasSize(width, height, rotationDegrees);
  const imageAspect = canvas.width / canvas.height;
  const requestedAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : imageAspect;

  if (imageAspect > requestedAspect) {
    const cropWidth = requestedAspect / imageAspect;
    return { x: (1 - cropWidth) / 2, y: 0, width: cropWidth, height: 1 };
  }
  const cropHeight = imageAspect / requestedAspect;
  return { x: 0, y: (1 - cropHeight) / 2, width: 1, height: cropHeight };
};

export const visibleCropAspect = (
  width: number | undefined,
  height: number | undefined,
  transform: CanvasTransform,
) => {
  const canvas = visibleRotatedCanvasSize(width, height, transform.rotationDegrees);
  const crop = transform.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  return (canvas.width * crop.width) / Math.max(1e-9, canvas.height * crop.height);
};

/**
 * Resolves stored expansion pixels for the canvas currently being rendered.
 * Older stacks omitted reference dimensions and intentionally retain their raw
 * pixel behavior.
 */
export const resolveCanvasExpansion = (
  expansion: CanvasExpansion | undefined,
  contentWidth: number,
  contentHeight: number,
): CanvasExpansion => {
  const source = expansion ?? { top: 0, right: 0, bottom: 0, left: 0 };
  const hasReference = (
    Number.isFinite(source.referenceWidth)
    && Number.isFinite(source.referenceHeight)
    && (source.referenceWidth ?? 0) > 0
    && (source.referenceHeight ?? 0) > 0
  );
  if (!hasReference) {
    return { top: source.top, right: source.right, bottom: source.bottom, left: source.left };
  }
  const horizontalScale = Math.max(0, contentWidth) / source.referenceWidth!;
  const verticalScale = Math.max(0, contentHeight) / source.referenceHeight!;
  return {
    top: source.top * verticalScale,
    right: source.right * horizontalScale,
    bottom: source.bottom * verticalScale,
    left: source.left * horizontalScale,
  };
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
