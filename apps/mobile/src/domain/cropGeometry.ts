import type { Region } from './types';

export type CropCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

export type CropViewportSize = {
  width: number;
  height: number;
};

export type CropGestureDelta = {
  dx: number;
  dy: number;
};

export const DEFAULT_CROP_REGION: Region = { x: 0, y: 0, width: 1, height: 1 };
export const DEFAULT_CROP_MINIMUM_SIZE = 0.12;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const finiteOr = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);

/** Keeps a crop finite, large enough, and inside normalized image bounds. */
export const normalizeCropRegion = (
  region: Region,
  minimumSize = DEFAULT_CROP_MINIMUM_SIZE,
): Region => {
  const minimum = clamp(finiteOr(minimumSize, DEFAULT_CROP_MINIMUM_SIZE), 0.02, 1);
  const width = clamp(finiteOr(region.width, DEFAULT_CROP_REGION.width), minimum, 1);
  const height = clamp(finiteOr(region.height, DEFAULT_CROP_REGION.height), minimum, 1);

  return {
    x: clamp(finiteOr(region.x, DEFAULT_CROP_REGION.x), 0, 1 - width),
    y: clamp(finiteOr(region.y, DEFAULT_CROP_REGION.y), 0, 1 - height),
    width,
    height,
  };
};

/** Returns the largest centered crop inside `region` with the requested output ratio. */
export const cropRegionForAspectRatio = (
  region: Region,
  aspectRatio: number,
  viewport: CropViewportSize,
  minimumSize = DEFAULT_CROP_MINIMUM_SIZE,
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

  const normalizedAspect = aspectRatio * viewport.height / viewport.width;
  let width = source.width;
  let height = source.height;

  if (width / height > normalizedAspect) width = height * normalizedAspect;
  else height = width / normalizedAspect;

  const centerX = source.x + source.width / 2;
  const centerY = source.y + source.height / 2;
  return normalizeCropRegion({
    x: centerX - width / 2,
    y: centerY - height / 2,
    width,
    height,
  }, minimumSize);
};

export const moveCropRegion = (
  source: Region,
  gesture: CropGestureDelta,
  viewport: CropViewportSize,
): Region => ({
  ...source,
  x: clamp(source.x + gesture.dx / viewport.width, 0, 1 - source.width),
  y: clamp(source.y + gesture.dy / viewport.height, 0, 1 - source.height),
});

export const resizeCropRegion = (
  source: Region,
  corner: CropCorner,
  gesture: CropGestureDelta,
  viewport: CropViewportSize,
  minimumSize = DEFAULT_CROP_MINIMUM_SIZE,
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
  const horizontalDirection = movesLeft ? -1 : 1;
  const verticalDirection = movesTop ? -1 : 1;
  const minimum = clamp(minimumSize, 0.02, 1);

  if (lockedAspectRatio && Number.isFinite(lockedAspectRatio) && lockedAspectRatio > 0) {
    // Project in physical pixels. Projecting normalized x/y values makes the
    // corner lag or accelerate whenever the image viewport is not square.
    const requestedWidth = Math.max(0, source.width * viewport.width + horizontalDirection * gesture.dx);
    const requestedHeight = Math.max(0, source.height * viewport.height + verticalDirection * gesture.dy);
    const projectedHeight = (
      lockedAspectRatio * requestedWidth + requestedHeight
    ) / (lockedAspectRatio * lockedAspectRatio + 1);
    const maximumWidth = (movesLeft ? anchorX : 1 - anchorX) * viewport.width;
    const maximumHeight = (movesTop ? anchorY : 1 - anchorY) * viewport.height;
    const minimumHeight = Math.max(minimum * viewport.height, minimum * viewport.width / lockedAspectRatio);
    const maximumLockedHeight = Math.min(maximumHeight, maximumWidth / lockedAspectRatio);
    const heightPixels = clamp(
      projectedHeight,
      Math.min(minimumHeight, maximumLockedHeight),
      maximumLockedHeight,
    );
    const width = heightPixels * lockedAspectRatio / viewport.width;
    const height = heightPixels / viewport.height;

    return normalizeCropRegion({
      x: movesLeft ? anchorX - width : anchorX,
      y: movesTop ? anchorY - height : anchorY,
      width,
      height,
    }, Math.min(minimum, width, height));
  }

  const startX = movesLeft ? left : right;
  const startY = movesTop ? top : bottom;
  const pointerX = startX + gesture.dx / viewport.width;
  const pointerY = startY + gesture.dy / viewport.height;
  const nextLeft = movesLeft ? clamp(pointerX, 0, right - minimum) : left;
  const nextRight = movesLeft ? right : clamp(pointerX, left + minimum, 1);
  const nextTop = movesTop ? clamp(pointerY, 0, bottom - minimum) : top;
  const nextBottom = movesTop ? bottom : clamp(pointerY, top + minimum, 1);

  return {
    x: nextLeft,
    y: nextTop,
    width: nextRight - nextLeft,
    height: nextBottom - nextTop,
  };
};

export const displayedCropAspect = (region: Region, viewport: CropViewportSize) => (
  region.width * viewport.width / Math.max(1e-9, region.height * viewport.height)
);
