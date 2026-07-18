import { fetch } from 'expo/fetch';
import { File } from 'expo-file-system';

import { exifForRemoteAnalysis } from '../data/photoRepository';
import { loadPreferences } from '../data/preferences';
import { ensureLocalOriginal } from './cloudOriginal';
import { apiErrorMessage, resolveApiUrl } from '../domain/apiConfiguration';
import { layerAssetsForStack } from '../domain/assets';
import { currentVersion } from '../domain/layers';
import type {
  AdjustmentValues,
  AnalysisResult,
  CoachResponse,
  GenerativeOperation,
  LayerStack,
  PhotoRecord,
  Region,
} from '../domain/types';

export class ApiUnavailableError extends Error {}

const requireApiUrl = async () => {
  const preferences = await loadPreferences();
  const apiUrl = resolveApiUrl(
    process.env.EXPO_PUBLIC_LAUNCHER_API_URL,
    process.env.EXPO_PUBLIC_API_URL,
    preferences.apiUrl,
  );
  if (!apiUrl) throw new ApiUnavailableError('Set the Exposure API URL in Settings to enable analysis and export.');
  return apiUrl;
};

const apiFetch = async (path: string, init: Parameters<typeof fetch>[1]) => {
  const apiUrl = await requireApiUrl();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    path === '/v1/layers/generative' ? 180_000 : path === '/v1/render' ? 120_000 : 45_000,
  );
  try {
    return await fetch(`${apiUrl}${path}`, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new ApiUnavailableError('The Exposure service timed out. Try again when the connection is stable.');
    const detail = error instanceof Error ? error.message : 'Network request failed.';
    throw new ApiUnavailableError(`Could not reach the Exposure API at ${apiUrl}. ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
};

const parseResponse = async <T>(response: Response): Promise<T> => {
  if (!response.ok) {
    const body = await response.text();
    throw new Error(apiErrorMessage(body, response.status));
  }
  return (await response.json()) as T;
};

export const analyzePhoto = async (photo: PhotoRecord): Promise<AnalysisResult> => {
  const preferences = await loadPreferences();
  const stack = currentVersion(photo).stack;
  const form = new FormData();
  const proxy = new File(photo.analysisProxyUri);
  form.append('image', proxy as unknown as Blob, proxy.name);
  form.append('version_id', photo.currentVersionId);
  form.append('checksum', photo.originalChecksum);
  form.append('exif_json', JSON.stringify(exifForRemoteAnalysis(photo.exif)));
  form.append('layer_stack_json', JSON.stringify(stack));
  const assets = layerAssetsForStack(stack);
  for (const asset of assets) {
    const file = new File(asset.uri);
    form.append('assets', file as unknown as Blob, file.name);
  }
  form.append('asset_ids_json', JSON.stringify(assets.map((asset) => asset.id)));
  form.append('coaching_json', JSON.stringify({
    detail: preferences.detail,
    skillLevel: preferences.skillLevel,
    desiredMood: preferences.desiredMood,
  }));

  const response = await apiFetch('/v1/analyze', { method: 'POST', body: form });
  return parseResponse<AnalysisResult>(response);
};

export const askCoach = async (
  analysis: AnalysisResult,
  question: string,
  context: { stack?: LayerStack; selectedIssueId?: string } = {},
): Promise<CoachResponse> => {
  const preferences = await loadPreferences();
  const response = await apiFetch('/v1/coach', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      analysis,
      question,
      preferences: {
        detail: preferences.detail,
        skillLevel: preferences.skillLevel,
        desiredMood: preferences.desiredMood,
        recommendationFeedback: preferences.recommendationFeedback,
      },
      layerStack: context.stack,
      selectedIssueId: context.selectedIssueId,
      availableTools: ['adjust_global', 'adjust_masked', 'crop', 'straighten', 'remove', 'add', 'expand', 'retake'],
    }),
  });
  return parseResponse<CoachResponse>(response);
};

export const requestRender = async (
  photo: PhotoRecord,
  stack: LayerStack,
  options: { includeMetadata: boolean; includeGps: boolean },
) => {
  const form = new FormData();
  const original = await ensureLocalOriginal(photo);
  form.append('image', original as unknown as Blob, original.name);
  form.append('layer_stack_json', JSON.stringify(stack));
  form.append('include_metadata', String(options.includeMetadata));
  form.append('include_gps', String(options.includeGps));
  const assets = layerAssetsForStack(stack);
  for (const asset of assets) {
    const file = new File(asset.uri);
    form.append('assets', file as unknown as Blob, file.name);
  }
  form.append('asset_ids_json', JSON.stringify(assets.map((asset) => asset.id)));
  const response = await apiFetch('/v1/render', { method: 'POST', body: form });
  if (!response.ok) throw new Error(await response.text());
  return response.blob();
};

export type GenerativePatchResult = {
  patchBase64: string;
  maskBase64: string;
  target: Region;
  driftScore: number;
  model: string;
  sourceVersionId: string;
  expansion?: { top: number; right: number; bottom: number; left: number };
};

export const createGenerativePatch = async (
  photo: PhotoRecord,
  stack: LayerStack,
  target: Region,
  prompt: string,
  operation: GenerativeOperation = 'remove',
  expansionDirection: 'top' | 'right' | 'bottom' | 'left' = 'right',
): Promise<GenerativePatchResult> => {
  const form = new FormData();
  const original = await ensureLocalOriginal(photo);
  form.append('image', original as unknown as Blob, original.name);
  form.append('target_json', JSON.stringify(target));
  form.append('prompt', prompt);
  form.append('operation', operation);
  if (operation === 'expand') {
    form.append('expansion_json', JSON.stringify({ direction: expansionDirection, fraction: 0.25 }));
  }
  form.append('source_version_id', photo.currentVersionId);
  form.append('layer_stack_json', JSON.stringify(stack));
  const assets = layerAssetsForStack(stack);
  for (const asset of assets) {
    const file = new File(asset.uri);
    form.append('assets', file as unknown as Blob, file.name);
  }
  form.append('asset_ids_json', JSON.stringify(assets.map((asset) => asset.id)));
  const response = await apiFetch('/v1/layers/generative', { method: 'POST', body: form });
  return parseResponse<GenerativePatchResult>(response);
};

export type PortfolioReview = {
  orderedPhotoIds: string[];
  excludedPhotoIds: string[];
  duplicateGroups: string[][];
  explanations: Record<string, string>;
  summary: string;
};

export const reviewPortfolio = async (photos: PhotoRecord[]) => {
  const form = new FormData();
  photos.forEach((photo) => {
    const file = new File(photo.analysisProxyUri);
    form.append('images', file as unknown as Blob, `${photo.id}.jpg`);
  });
  form.append('photo_ids_json', JSON.stringify(photos.map((photo) => photo.id)));
  const response = await apiFetch('/v1/portfolio-review', { method: 'POST', body: form });
  return parseResponse<PortfolioReview>(response);
};

export type StyleProfileResult = {
  id: string;
  name: string;
  adjustments: AdjustmentValues;
  palette: string[];
  mood: string;
};

export const createStyleProfile = async (photos: PhotoRecord[]) => {
  const form = new FormData();
  photos.forEach((photo) => {
    const file = new File(photo.analysisProxyUri);
    form.append('images', file as unknown as Blob, `${photo.id}.jpg`);
  });
  const response = await apiFetch('/v1/style-profile', { method: 'POST', body: form });
  return parseResponse<StyleProfileResult>(response);
};
