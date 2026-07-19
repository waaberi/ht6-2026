import assert from 'node:assert/strict';
import test from 'node:test';

import {
  analysisWithEditableMetadata,
  editableMetadataFrom,
  exifWithEditableMetadata,
  filledMetadataFieldCount,
} from './photoMetadata';
import type { AnalysisResult } from './types';

const analysis = (): AnalysisResult => ({
  versionId: 'version',
  checksum: 'checksum',
  createdAt: '2026-01-01T00:00:00.000Z',
  deterministicModel: 'fixture',
  metrics: { meanLuminance: 0.2, exifIso: 100 },
  lighting: {
    exposure: -0.3,
    contrast: 0.15,
    clippedShadows: 0.1,
    clippedHighlights: 0,
    colorCast: { red: 0, green: 0, blue: 0 },
  },
  signals: [],
  issues: [],
  cameraRecommendations: [],
  summary: 'Fixture',
});

test('editable metadata is populated from common EXIF fields and metric fallbacks', () => {
  const metadata = editableMetadataFrom({
    Model: 'Camera X',
    LensModel: 'Prime 35',
    FNumber: 2.8,
    ExposureTime: 1 / 125,
    FocalLength: [35, 1],
  }, analysis());

  assert.deepEqual(metadata, {
    camera: 'Camera X',
    lens: 'Prime 35',
    iso: '100',
    aperture: 'f/2.8',
    shutterSpeed: '1/125 s',
    focalLength: '35 mm',
  });
});

test('metadata edits replace canonical EXIF fields without dropping unrelated metadata', () => {
  const updated = exifWithEditableMetadata({ Make: 'Old', GPSLatitude: 45, Artist: 'Me' }, {
    camera: 'Camera Y',
    lens: 'Zoom 24-70',
    iso: '400',
    aperture: 'f/4',
    shutterSpeed: '1/60 s',
    focalLength: '50 mm',
  });

  assert.equal(updated.Make, undefined);
  assert.equal(updated.Model, 'Camera Y');
  assert.equal(updated.ISO, 400);
  assert.equal(updated.FNumber, 4);
  assert.equal(updated.ExposureTime, 1 / 60);
  assert.equal(updated.FocalLength, 50);
  assert.equal(updated.Artist, 'Me');
  assert.equal(updated.GPSLatitude, 45);
});

test('edited metadata becomes grounded Coach evidence and blank fields stay absent', () => {
  const enriched = analysisWithEditableMetadata(analysis(), {
    camera: 'Camera Z',
    lens: '',
    iso: '800',
    aperture: 'f/1.8',
    shutterSpeed: '1/30 s',
    focalLength: '35 mm',
  });

  assert.equal(enriched.metrics.exifCamera, 'Camera Z');
  assert.equal(enriched.metrics.exifLens, undefined);
  assert.equal(enriched.metrics.exifIso, 800);
  assert.equal(enriched.metrics.exifAperture, 1.8);
  assert.equal(enriched.metrics.exifExposureTimeSeconds, 1 / 30);
  assert.equal(enriched.metrics.exifFocalLengthMm, 35);
});

test('hardware advice requires more than three populated metadata fields', () => {
  assert.equal(filledMetadataFieldCount({
    camera: 'Camera Z',
    lens: '',
    iso: '800',
    aperture: 'f/1.8',
    shutterSpeed: '',
    focalLength: '',
  }), 3);
  assert.equal(filledMetadataFieldCount({
    camera: 'Camera Z',
    lens: '35mm F2',
    iso: '800',
    aperture: 'f/1.8',
    shutterSpeed: '',
    focalLength: '',
  }), 4);
});
