import { Directory, File, Paths } from 'expo-file-system';

import { layerAssetsForStacks } from '../domain/assets';
import { mergeStyleProfiles, type SavedStyleProfile } from '../data/styleRepository';
import { clearPhotoDeletionId } from '../data/photoRepository';
import { loadPreferences, savePreferences, type ExposurePreferences } from '../data/preferences';
import type { AnalysisResult, Layer, PhotoRecord, PhotoVersion } from '../domain/types';
import type { PortfolioReview, StyleProfileResult } from './api';
import { supabase } from './supabase';

const uploadOnce = async (bucket: string, path: string, uri: string, contentType: string) => {
  if (!supabase) return;
  const bytes = await new File(uri).arrayBuffer();
  const { error } = await supabase.storage.from(bucket).upload(path, bytes, { contentType, upsert: false });
  if (error && !/already exists|duplicate/i.test(error.message)) throw error;
};

export const syncPhotoDeletions = async (photoIds: string[]): Promise<string[]> => {
  if (!supabase || photoIds.length === 0) return [];
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user.id;
  if (!userId) return [];

  const completed: string[] = [];
  for (const photoId of photoIds) {
    const [{ data: photo, error: photoError }, { data: assets, error: assetsError }] = await Promise.all([
      supabase.from('photos').select('original_path').eq('id', photoId).eq('owner_id', userId).maybeSingle(),
      supabase.from('layer_assets').select('storage_path').eq('photo_id', photoId).eq('owner_id', userId),
    ]);
    if (photoError) throw photoError;
    if (assetsError) throw assetsError;

    const originalPath = photo?.original_path as string | undefined;
    if (originalPath) {
      const base = originalPath.replace(/\/original\.[^/]+$/, '');
      const { error } = await supabase.storage.from('originals').remove([originalPath]);
      if (error) throw error;
      const { error: derivedError } = await supabase.storage.from('derived').remove([
        `${base}/analysis-proxy.jpg`,
        `${base}/thumbnail.jpg`,
      ]);
      if (derivedError) throw derivedError;
    }
    const assetPaths = (assets ?? []).map((asset) => asset.storage_path as string);
    if (assetPaths.length) {
      const { error } = await supabase.storage.from('layer-assets').remove(assetPaths);
      if (error) throw error;
    }
    const { error: deleteError } = await supabase.from('photos').delete().eq('id', photoId).eq('owner_id', userId);
    if (deleteError) throw deleteError;
    await clearPhotoDeletionId(photoId);
    completed.push(photoId);
  }
  return completed;
};

export const syncQueuedPhotos = async (
  photos: PhotoRecord[],
  onProgress?: (photos: PhotoRecord[]) => void,
): Promise<PhotoRecord[]> => {
  if (!supabase) return photos;
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) return photos;

  const synced = [...photos];
  for (let index = 0; index < synced.length; index += 1) {
    const photo = synced[index];
    if (photo.syncState === 'synced') continue;
    const base = `${userId}/${photo.id}`;
    try {
      synced[index] = { ...photo, syncState: 'syncing' };
      onProgress?.([...synced]);
      const localOriginal = new File(photo.originalUri);
      const originalPath = photo.remoteOriginalPath
        ?? `${base}/original.${localOriginal.extension.replace('.', '') || 'jpg'}`;
      if (localOriginal.exists) {
        await uploadOnce('originals', originalPath, photo.originalUri, photo.originalMimeType);
      } else if (!photo.remoteOriginalPath) {
        throw new Error('The local original is missing.');
      }
      await Promise.all([
        uploadOnce('derived', `${base}/analysis-proxy.jpg`, photo.analysisProxyUri, 'image/jpeg'),
        uploadOnce('derived', `${base}/thumbnail.jpg`, photo.thumbnailUri, 'image/jpeg'),
      ]);
      const { error: photoError } = await supabase.from('photos').upsert({
        id: photo.id,
        owner_id: userId,
        original_path: originalPath,
        original_name: photo.originalName,
        original_mime_type: photo.originalMimeType,
        original_byte_size: photo.originalByteSize,
        original_checksum: photo.originalChecksum,
        capture_source: photo.captureSource,
        width: photo.width,
        height: photo.height,
        exif: photo.exif,
        created_at: photo.createdAt,
        current_version_id: null,
        sync_state: 'syncing',
      }, { onConflict: 'id', ignoreDuplicates: true });
      if (photoError) throw photoError;
      const layerAssets = layerAssetsForStacks(photo.versions.map((version) => version.stack));
      for (const asset of layerAssets) {
        const file = new File(asset.uri);
        const storagePath = `${base}/layers/${asset.id}.${asset.mimeType === 'image/png' ? 'png' : 'jpg'}`;
        await uploadOnce('layer-assets', storagePath, asset.uri, asset.mimeType);
        const { error: assetError } = await supabase.from('layer_assets').upsert({
          id: asset.id,
          owner_id: userId,
          photo_id: photo.id,
          kind: asset.kind,
          storage_path: storagePath,
          checksum: file.md5 ?? `${file.size}:${asset.id}`,
          mime_type: asset.mimeType,
          provenance: {},
        }, { onConflict: 'id', ignoreDuplicates: true });
        if (assetError) throw assetError;
      }
      const { error: versionsError } = await supabase.from('photo_versions').upsert(photo.versions.map((version) => ({
        id: version.id,
        photo_id: photo.id,
        parent_version_id: version.parentVersionId,
        restored_from_version_id: version.restoredFromVersionId,
        label: version.label,
        canvas_transform: version.stack.canvasTransform,
        adjustments: version.stack.adjustments ?? {},
        layer_stack: version.stack.layers,
        analysis_proxy_path: `${base}/analysis-proxy.jpg`,
        thumbnail_path: `${base}/thumbnail.jpg`,
        created_at: version.createdAt,
      })), { onConflict: 'id', ignoreDuplicates: true });
      if (versionsError) throw versionsError;
      const { error: currentError } = await supabase.from('photos').update({ current_version_id: photo.currentVersionId, sync_state: 'synced' }).eq('id', photo.id);
      if (currentError) throw currentError;
      synced[index] = { ...photo, remoteOriginalPath: originalPath, syncState: 'synced' };
      onProgress?.([...synced]);
    } catch {
      synced[index] = { ...photo, syncState: 'failed' };
      onProgress?.([...synced]);
    }
  }
  return synced;
};

type RemotePhotoRow = {
  id: string;
  created_at: string;
  capture_source: PhotoRecord['captureSource'];
  original_path: string;
  original_name: string;
  original_mime_type: string;
  original_byte_size: number;
  original_checksum: string;
  width?: number | null;
  height?: number | null;
  exif?: Record<string, unknown> | null;
  current_version_id: string | null;
};

type RemoteVersionRow = {
  id: string;
  photo_id: string;
  parent_version_id?: string | null;
  restored_from_version_id?: string | null;
  label: string;
  canvas_transform: PhotoVersion['stack']['canvasTransform'];
  adjustments?: PhotoVersion['stack']['adjustments'] | null;
  layer_stack: Layer[];
  analysis_proxy_path?: string | null;
  thumbnail_path?: string | null;
  created_at: string;
};

type RemoteLayerAssetRow = {
  id: string;
  photo_id: string;
  storage_path: string;
  mime_type: string;
};

const exposureDirectory = new Directory(Paths.document, 'exposure');
const originalsDirectory = new Directory(exposureDirectory, 'originals');
const proxiesDirectory = new Directory(exposureDirectory, 'proxies');
const thumbnailsDirectory = new Directory(exposureDirectory, 'thumbnails');
const layerAssetsDirectory = new Directory(exposureDirectory, 'layer-assets');

const ensureSyncDirectories = () => {
  exposureDirectory.create({ intermediates: true, idempotent: true });
  originalsDirectory.create({ intermediates: true, idempotent: true });
  proxiesDirectory.create({ intermediates: true, idempotent: true });
  thumbnailsDirectory.create({ intermediates: true, idempotent: true });
  layerAssetsDirectory.create({ intermediates: true, idempotent: true });
};

const extensionForPath = (path: string, fallback = 'jpg') => path.match(/\.([a-z0-9]+)$/i)?.[1] ?? fallback;

const downloadPrivateObject = async (bucket: string, path: string, destination: File) => {
  if (!supabase || destination.exists) return;
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 10 * 60);
  if (error) throw error;
  await File.downloadFileAsync(data.signedUrl, destination, { idempotent: true });
};

const mapWithConcurrency = async <T, R>(items: T[], limit: number, work: (item: T) => Promise<R>) => {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await work(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
};

const withLocalAssetUris = (layer: Layer, assetUris: Map<string, string>): Layer => {
  if (layer.type === 'image') {
    return { ...layer, uri: assetUris.get(layer.assetId) ?? layer.uri };
  }
  if (layer.type === 'retouch' || layer.type === 'generative-patch') {
    return {
      ...layer,
      patchUri: assetUris.get(layer.patchAssetId) ?? layer.patchUri,
      maskUri: assetUris.get(layer.maskAssetId) ?? layer.maskUri,
    };
  }
  if (layer.type === 'masked-adjustment' && layer.mask.assetId) {
    return { ...layer, mask: { ...layer.mask, uri: assetUris.get(layer.mask.assetId) ?? layer.mask.uri } };
  }
  return layer;
};

const hydrateRemotePhoto = async (
  photo: RemotePhotoRow,
  versions: RemoteVersionRow[],
  assets: RemoteLayerAssetRow[],
): Promise<PhotoRecord> => {
  ensureSyncDirectories();
  const original = new File(originalsDirectory, `${photo.id}.${extensionForPath(photo.original_path)}`);
  const proxy = new File(proxiesDirectory, `${photo.id}.jpg`);
  const thumbnail = new File(thumbnailsDirectory, `${photo.id}.jpg`);
  const currentVersion = versions.find((version) => version.id === photo.current_version_id) ?? versions.at(-1);

  await Promise.all([
    currentVersion?.analysis_proxy_path ? Promise.resolve() : downloadPrivateObject('originals', photo.original_path, original),
    currentVersion?.analysis_proxy_path
      ? downloadPrivateObject('derived', currentVersion.analysis_proxy_path, proxy)
      : Promise.resolve(),
    currentVersion?.thumbnail_path
      ? downloadPrivateObject('derived', currentVersion.thumbnail_path, thumbnail)
      : Promise.resolve(),
  ]);

  const assetUris = new Map<string, string>();
  await mapWithConcurrency(assets, 4, async (asset) => {
    const local = new File(layerAssetsDirectory, `${asset.id}.${extensionForPath(asset.storage_path, asset.mime_type === 'image/png' ? 'png' : 'jpg')}`);
    await downloadPrivateObject('layer-assets', asset.storage_path, local);
    assetUris.set(asset.id, local.uri);
  });

  const hydratedVersions: PhotoVersion[] = versions
    .sort((left, right) => Date.parse(left.created_at) - Date.parse(right.created_at))
    .map((version) => ({
      id: version.id,
      photoId: photo.id,
      parentVersionId: version.parent_version_id ?? undefined,
      restoredFromVersionId: version.restored_from_version_id ?? undefined,
      createdAt: version.created_at,
      label: version.label,
      stack: {
        canvasTransform: version.canvas_transform,
        adjustments: version.adjustments ?? {},
        layers: version.layer_stack.map((layer) => withLocalAssetUris(layer, assetUris)),
      },
    }));

  return {
    id: photo.id,
    createdAt: photo.created_at,
    captureSource: photo.capture_source,
    originalUri: original.uri,
    remoteOriginalPath: photo.original_path,
    originalName: photo.original_name,
    originalMimeType: photo.original_mime_type,
    originalByteSize: Number(photo.original_byte_size),
    originalChecksum: photo.original_checksum,
    analysisProxyUri: proxy.exists ? proxy.uri : original.uri,
    thumbnailUri: thumbnail.exists ? thumbnail.uri : proxy.exists ? proxy.uri : original.uri,
    width: photo.width ?? undefined,
    height: photo.height ?? undefined,
    exif: photo.exif ?? {},
    currentVersionId: photo.current_version_id ?? currentVersion?.id ?? hydratedVersions.at(-1)?.id ?? '',
    versions: hydratedVersions,
    syncState: 'synced',
  };
};

/**
 * Pulls the private cloud library after sign-in so another device can rebuild
 * the same originals, version stacks, and generated/imported layer assets.
 */
export const pullRemotePhotos = async (localPhotos: PhotoRecord[], excludedPhotoIds: string[] = []): Promise<PhotoRecord[]> => {
  if (!supabase) return localPhotos;
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user.id;
  if (!userId) return localPhotos;

  const { data: photoRows, error: photoError } = await supabase
    .from('photos')
    .select('*')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false });
  if (photoError) throw photoError;
  const excluded = new Set(excludedPhotoIds);
  const visibleRows = (photoRows ?? []).filter((row) => !excluded.has(row.id as string));
  if (!visibleRows.length) return localPhotos;

  const photoIds = visibleRows.map((row) => row.id as string);
  const [{ data: versionRows, error: versionError }, { data: assetRows, error: assetError }] = await Promise.all([
    supabase.from('photo_versions').select('*').in('photo_id', photoIds),
    supabase.from('layer_assets').select('*').in('photo_id', photoIds),
  ]);
  if (versionError) throw versionError;
  if (assetError) throw assetError;

  const remote = await mapWithConcurrency(visibleRows as RemotePhotoRow[], 3, (photo) => hydrateRemotePhoto(
    photo,
    (versionRows as RemoteVersionRow[]).filter((version) => version.photo_id === photo.id),
    (assetRows as RemoteLayerAssetRow[]).filter((asset) => asset.photo_id === photo.id),
  ));

  const merged = new Map(localPhotos.map((photo) => [photo.id, photo]));
  for (const photo of remote) {
    const local = merged.get(photo.id);
    const hasUnsyncedLocalHistory = local && local.versions.some((version) => !photo.versions.some((remoteVersion) => remoteVersion.id === version.id));
    merged.set(photo.id, local && (local.syncState !== 'synced' || hasUnsyncedLocalHistory) ? local : photo);
  }
  return [...merged.values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
};

export const pullRemoteAnalyses = async (): Promise<Record<string, AnalysisResult>> => {
  if (!supabase) return {};
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user.id;
  if (!userId) return {};
  const { data, error } = await supabase
    .from('analyses')
    .select('*')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;

  const analyses: Record<string, AnalysisResult> = {};
  for (const row of data ?? []) {
    if (row.schema_version !== 'analysis-2') continue;
    const versionId = row.version_id as string;
    if (analyses[versionId]) continue;
    analyses[versionId] = {
      versionId,
      checksum: row.checksum as string,
      createdAt: row.created_at as string,
      deterministicModel: row.deterministic_model as string,
      semanticModel: (row.semantic_model as string | null) ?? undefined,
      metrics: (row.metrics ?? {}) as AnalysisResult['metrics'],
      lighting: row.lighting as AnalysisResult['lighting'],
      signals: (row.signals ?? []) as AnalysisResult['signals'],
      cameraRecommendations: (row.camera_recommendations ?? []) as AnalysisResult['cameraRecommendations'],
      issues: (row.issues ?? []) as AnalysisResult['issues'],
      summary: row.summary as string,
    };
  }
  return analyses;
};

export const pullRemoteStyles = async () => {
  if (!supabase) return;
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user.id;
  if (!userId) return;
  const { data, error } = await supabase
    .from('style_profiles')
    .select('*')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  await mergeStyleProfiles((data ?? []).map((row) => ({
    id: row.id as string,
    name: row.name as string,
    referencePhotoIds: (row.reference_photo_ids ?? []) as string[],
    palette: (row.palette ?? []) as string[],
    adjustments: (row.adjustments ?? {}) as SavedStyleProfile['adjustments'],
    mood: row.mood as string,
    createdAt: row.created_at as string,
  })));
};

export const pullRemotePreferences = async () => {
  if (!supabase) return;
  const { data: sessionData } = await supabase.auth.getSession();
  const userId = sessionData.session?.user.id;
  if (!userId) return;
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  if (!data) return;
  const local = await loadPreferences();
  await savePreferences({
    ...local,
    skillLevel: data.skill_level ?? local.skillLevel,
    detail: data.feedback_detail ?? local.detail,
    desiredMood: data.desired_mood ?? '',
    exportMetadata: data.export_metadata ?? local.exportMetadata,
    exportGps: data.export_gps ?? local.exportGps,
    recommendationFeedback: data.recommendation_feedback ?? local.recommendationFeedback,
    camera: { ...local.camera, ...(data.camera_preferences ?? {}) },
  });
};

export const persistAnalysis = async (photo: PhotoRecord, analysis: AnalysisResult) => {
  if (!supabase) return;
  const { data } = await supabase.auth.getSession();
  const ownerId = data.session?.user.id;
  if (!ownerId) return;
  const { error } = await supabase.from('analyses').upsert({
    owner_id: ownerId,
    photo_id: photo.id,
    version_id: photo.currentVersionId,
    checksum: analysis.checksum,
    schema_version: 'analysis-2',
    deterministic_model: analysis.deterministicModel,
    semantic_model: analysis.semanticModel,
    metrics: analysis.metrics,
    lighting: analysis.lighting,
    signals: analysis.signals,
    camera_recommendations: analysis.cameraRecommendations,
    issues: analysis.issues,
    summary: analysis.summary,
  }, { ignoreDuplicates: true });
  if (error) throw error;
};

export const persistStyleProfile = async (style: StyleProfileResult, referencePhotoIds: string[]) => {
  if (!supabase) return;
  const { data } = await supabase.auth.getSession();
  const ownerId = data.session?.user.id;
  if (!ownerId) return;
  const { error } = await supabase.from('style_profiles').upsert({
    id: style.id,
    owner_id: ownerId,
    name: style.name,
    reference_photo_ids: referencePhotoIds,
    palette: style.palette,
    adjustments: style.adjustments,
    mood: style.mood,
    model_versions: { extractor: 'exposure-style-1' },
  }, { onConflict: 'id' });
  if (error) throw error;
};

export const persistPortfolioReview = async (review: PortfolioReview, selectedPhotoIds: string[]) => {
  if (!supabase) return;
  const { data } = await supabase.auth.getSession();
  const ownerId = data.session?.user.id;
  if (!ownerId) return;
  const { error } = await supabase.from('portfolio_reviews').insert({
    owner_id: ownerId,
    selected_photo_ids: selectedPhotoIds,
    ordered_photo_ids: review.orderedPhotoIds,
    excluded_photo_ids: review.excludedPhotoIds,
    duplicate_groups: review.duplicateGroups,
    explanations: review.explanations,
    summary: review.summary,
  });
  if (error) throw error;
};

export const persistPreferences = async (preferences: ExposurePreferences) => {
  if (!supabase) return;
  const { data } = await supabase.auth.getSession();
  const userId = data.session?.user.id;
  if (!userId) return;
  const { error } = await supabase.from('profiles').upsert({
    id: userId,
    skill_level: preferences.skillLevel,
    feedback_detail: preferences.detail,
    desired_mood: preferences.desiredMood || null,
    export_metadata: preferences.exportMetadata,
    export_gps: preferences.exportGps,
    recommendation_feedback: preferences.recommendationFeedback,
    camera_preferences: preferences.camera,
  });
  if (error) throw error;
};
