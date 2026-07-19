import type { ExposurePreferences } from '../data/preferences';
import type { SavedStyleProfile } from '../data/styleRepository';
import type { AnalysisResult, PhotoRecord, PhotoVersion } from '../domain/types';
import type { PortfolioReview, StyleProfileResult } from './api';
import { apiFetch, parseResponse } from './api';

export type CloudPhotoVersion = {
  id: string;
  parentVersionId?: string | null;
  restoredFromVersionId?: string | null;
  label: string;
  stack: PhotoVersion['stack'];
  analysisProxyPath?: string | null;
  thumbnailPath?: string | null;
  createdAt: string;
};

export type CloudLayerAsset = {
  id: string;
  kind: 'mask' | 'donor_patch' | 'imported_image' | 'generated_patch';
  storagePath: string;
  checksum: string;
  mimeType: string;
};

export type CloudPhoto = {
  id: string;
  originalPath: string;
  originalName: string;
  originalMimeType: string;
  originalByteSize: number;
  originalChecksum: string;
  captureSource: PhotoRecord['captureSource'];
  width?: number | null;
  height?: number | null;
  exif: Record<string, unknown>;
  currentVersionId: string;
  createdAt: string;
  versions: CloudPhotoVersion[];
  layerAssets: CloudLayerAsset[];
};

export type DeletedCloudPhoto = {
  deleted: boolean;
  originalPath?: string | null;
  layerAssetPaths: string[];
};

type CloudPreferences = {
  skillLevel: ExposurePreferences['skillLevel'];
  feedbackDetail: ExposurePreferences['detail'];
  desiredMood: string;
  exportMetadata: boolean;
  exportGps: boolean;
  recommendationFeedback: ExposurePreferences['recommendationFeedback'];
  cameraPreferences: ExposurePreferences['camera'];
};

const jsonHeaders = { 'Content-Type': 'application/json' };
const identifier = (value: string) => encodeURIComponent(value);

const requestJson = async <T>(path: string, init: Parameters<typeof apiFetch>[1]): Promise<T> =>
  parseResponse<T>(await apiFetch(path, init));

const requestWithoutBody = async (path: string, method: 'DELETE' | 'POST') => {
  const response = await apiFetch(path, { method });
  if (!response.ok) await parseResponse<never>(response);
};

export const listCloudPhotos = () => requestJson<CloudPhoto[]>('/v1/sync/photos', { method: 'GET' });

export const upsertCloudPhoto = (photo: CloudPhoto) => requestJson<CloudPhoto>(
  `/v1/sync/photos/${identifier(photo.id)}`,
  { method: 'PUT', headers: jsonHeaders, body: JSON.stringify(photo) },
);

export const deleteCloudPhoto = (photoId: string) => requestJson<DeletedCloudPhoto>(
  `/v1/sync/photos/${identifier(photoId)}`,
  { method: 'DELETE' },
);

export const listCloudAnalyses = () => requestJson<AnalysisResult[]>('/v1/sync/analyses', { method: 'GET' });

export const upsertCloudAnalysis = (photoId: string, analysis: AnalysisResult) => requestJson<AnalysisResult>(
  `/v1/sync/analyses/${identifier(analysis.versionId)}`,
  { method: 'PUT', headers: jsonHeaders, body: JSON.stringify({ photoId, analysis }) },
);

export const listCloudStyles = () => requestJson<Array<{
  id: string;
  name: string;
  referencePhotoIds: string[];
  palette: string[];
  adjustments: SavedStyleProfile['adjustments'];
  mood: string;
  createdAt: string;
  updatedAt: string;
}>>('/v1/sync/styles', { method: 'GET' });

export const upsertCloudStyle = (
  style: StyleProfileResult,
  referencePhotoIds: string[],
  timestamps: { createdAt?: string; updatedAt?: string } = {},
) => {
  const now = new Date().toISOString();
  return requestJson(`/v1/sync/styles/${identifier(style.id)}`, {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({
      ...style,
      referencePhotoIds,
      modelVersions: referencePhotoIds.length
        ? { extractor: 'exposure-style-1', source: 'generated' }
        : { source: 'manual' },
      createdAt: timestamps.createdAt ?? now,
      updatedAt: timestamps.updatedAt ?? now,
    }),
  });
};

export const deleteCloudStyle = (styleId: string) =>
  requestWithoutBody(`/v1/sync/styles/${identifier(styleId)}`, 'DELETE');

export const getCloudPreferences = () =>
  requestJson<CloudPreferences | null>('/v1/sync/preferences', { method: 'GET' });

export const upsertCloudPreferences = (preferences: ExposurePreferences) => requestJson<CloudPreferences>(
  '/v1/sync/preferences',
  {
    method: 'PUT',
    headers: jsonHeaders,
    body: JSON.stringify({
      skillLevel: preferences.skillLevel,
      feedbackDetail: preferences.detail,
      desiredMood: preferences.desiredMood,
      exportMetadata: preferences.exportMetadata,
      exportGps: preferences.exportGps,
      recommendationFeedback: preferences.recommendationFeedback,
      cameraPreferences: preferences.camera,
    }),
  },
);

export const insertCloudPortfolioReview = async (
  review: PortfolioReview,
  selectedPhotoIds: string[],
) => {
  const response = await apiFetch('/v1/sync/portfolio-reviews', {
    method: 'POST',
    headers: jsonHeaders,
    body: JSON.stringify({ ...review, selectedPhotoIds }),
  });
  if (!response.ok) await parseResponse<never>(response);
};
