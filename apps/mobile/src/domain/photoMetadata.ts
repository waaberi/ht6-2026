import type { AnalysisResult } from './types';

export type EditablePhotoMetadata = {
  camera: string;
  lens: string;
  iso: string;
  aperture: string;
  shutterSpeed: string;
  focalLength: string;
};

const METADATA_KEYS = {
  camera: ['Model', 'Camera', 'Make'],
  lens: ['LensModel', 'Lens'],
  iso: ['ISO', 'ISOSpeedRatings', 'PhotographicSensitivity'],
  aperture: ['FNumber'],
  shutterSpeed: ['ExposureTime'],
  focalLength: ['FocalLength', 'FocalLengthIn35mmFilm'],
} as const;

const firstValue = (source: Record<string, unknown>, keys: readonly string[]) =>
  keys.map((key) => source[key]).find((value) => value !== undefined && value !== null && value !== '');

const finiteNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value) && value.length === 2) {
    const numerator = Number(value[0]);
    const denominator = Number(value[1]);
    return Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0
      ? numerator / denominator
      : undefined;
  }
  if (typeof value === 'object' && value) {
    const rational = value as { numerator?: unknown; denominator?: unknown };
    const numerator = Number(rational.numerator);
    const denominator = Number(rational.denominator);
    if (Number.isFinite(numerator) && Number.isFinite(denominator) && denominator !== 0) return numerator / denominator;
  }
  if (typeof value !== 'string') return undefined;
  const fraction = value.trim().match(/^(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)/);
  if (fraction) {
    const denominator = Number(fraction[2]);
    return denominator === 0 ? undefined : Number(fraction[1]) / denominator;
  }
  const parsed = Number(value.trim().match(/-?\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const textValue = (value: unknown) => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
};

const tidyNumber = (value: number, precision = 2) => Number(value.toFixed(precision)).toString();

const formatShutterSpeed = (value: number | undefined) => {
  if (value === undefined || value <= 0) return '';
  if (value < 1) {
    const reciprocal = 1 / value;
    const denominator = Math.round(reciprocal);
    if (denominator >= 2 && Math.abs(reciprocal - denominator) < 0.02) return `1/${denominator} s`;
  }
  return `${tidyNumber(value, 2)} s`;
};

const metricValue = (analysis: AnalysisResult | undefined, key: string) => analysis?.metrics[key];

export const editableMetadataFrom = (
  exif: Record<string, unknown>,
  analysis?: AnalysisResult,
): EditablePhotoMetadata => {
  const iso = finiteNumber(firstValue(exif, METADATA_KEYS.iso) ?? metricValue(analysis, 'exifIso'));
  const aperture = finiteNumber(firstValue(exif, METADATA_KEYS.aperture) ?? metricValue(analysis, 'exifAperture'));
  const shutter = finiteNumber(firstValue(exif, METADATA_KEYS.shutterSpeed) ?? metricValue(analysis, 'exifExposureTimeSeconds'));
  const focalLength = finiteNumber(firstValue(exif, METADATA_KEYS.focalLength) ?? metricValue(analysis, 'exifFocalLengthMm'));
  return {
    camera: textValue(firstValue(exif, METADATA_KEYS.camera) ?? metricValue(analysis, 'exifCamera')),
    lens: textValue(firstValue(exif, METADATA_KEYS.lens) ?? metricValue(analysis, 'exifLens')),
    iso: iso === undefined ? '' : tidyNumber(iso, 0),
    aperture: aperture === undefined ? '' : `f/${tidyNumber(aperture)}`,
    shutterSpeed: formatShutterSpeed(shutter),
    focalLength: focalLength === undefined ? '' : `${tidyNumber(focalLength)} mm`,
  };
};

const replaceExifValue = (
  target: Record<string, unknown>,
  keys: readonly string[],
  canonicalKey: string,
  input: string,
  numeric = false,
) => {
  keys.forEach((key) => delete target[key]);
  const trimmed = input.trim();
  if (!trimmed) return;
  target[canonicalKey] = numeric ? finiteNumber(trimmed) ?? trimmed : trimmed;
};

export const exifWithEditableMetadata = (
  exif: Record<string, unknown>,
  metadata: EditablePhotoMetadata,
) => {
  const next = { ...exif };
  replaceExifValue(next, METADATA_KEYS.camera, 'Model', metadata.camera);
  replaceExifValue(next, METADATA_KEYS.lens, 'LensModel', metadata.lens);
  replaceExifValue(next, METADATA_KEYS.iso, 'ISO', metadata.iso, true);
  replaceExifValue(next, METADATA_KEYS.aperture, 'FNumber', metadata.aperture, true);
  replaceExifValue(next, METADATA_KEYS.shutterSpeed, 'ExposureTime', metadata.shutterSpeed, true);
  replaceExifValue(next, METADATA_KEYS.focalLength, 'FocalLength', metadata.focalLength, true);
  return next;
};

export const analysisWithEditableMetadata = (
  analysis: AnalysisResult,
  metadata: EditablePhotoMetadata,
): AnalysisResult => {
  const metrics = { ...analysis.metrics };
  const values: Array<[string, string, boolean]> = [
    ['exifCamera', metadata.camera, false],
    ['exifLens', metadata.lens, false],
    ['exifIso', metadata.iso, true],
    ['exifAperture', metadata.aperture, true],
    ['exifExposureTimeSeconds', metadata.shutterSpeed, true],
    ['exifFocalLengthMm', metadata.focalLength, true],
  ];
  values.forEach(([key, input, numeric]) => {
    delete metrics[key];
    const value = numeric ? finiteNumber(input) : input.trim();
    if (value !== undefined && value !== '') metrics[key] = value;
  });
  return { ...analysis, metrics };
};

export const filledMetadataFieldCount = (metadata: EditablePhotoMetadata) =>
  Object.values(metadata).filter((value) => value.trim().length > 0).length;
