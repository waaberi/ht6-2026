import { Directory, File, Paths } from 'expo-file-system';

import { layerAssetsForStacks } from '../domain/assets';
import { clearStyleProfileDeletionId, mergeStyleProfiles, type SavedStyleProfile } from '../data/styleRepository';
import { clearPhotoDeletionId } from '../data/photoRepository';
import { loadPreferences, savePreferences, type ExposurePreferences } from '../data/preferences';
import { getActiveOwnerId } from '../data/ownerScope';
import {
  GUEST_OWNER_ID,
  assertAuthenticatedOwner,
  assertOwnerMatches,
  ownerDirectorySegment,
  type OwnerId,
} from '../domain/ownership';
import {
  fulfilledValues,
  mapSettledWithConcurrency,
  retryBestEffort,
} from '../domain/syncReliability';
import type { AnalysisResult, Layer, PhotoRecord, PhotoVersion } from '../domain/types';
import type { PortfolioReview, StyleProfileResult } from './api';
import { getCurrentAuthUser } from './auth';
import {
  deleteCloudPhoto,
  deleteCloudStyle,
  getCloudPreferences,
  insertCloudPortfolioReview,
  listCloudAnalyses,
  listCloudPhotos,
  listCloudStyles,
  upsertCloudAnalysis,
  upsertCloudPhoto,
  upsertCloudPreferences,
  upsertCloudStyle,
  type CloudLayerAsset,
  type CloudPhoto,
  type CloudPhotoVersion,
} from './cloudDatabase';
import { supabase } from './supabase';

const requireSessionOwner = async (ownerId: OwnerId) => {
  return assertAuthenticatedOwner(ownerId, getCurrentAuthUser()?.sub);
};

const uploadOnce = async (bucket: string, path: string, uri: string, contentType: string) => {
  if (!supabase) return;
  const bytes = await new File(uri).arrayBuffer();
  const { error } = await supabase.storage.from(bucket).upload(path, bytes, { contentType, upsert: false });
  if (error && !/already exists|duplicate/i.test(error.message)) throw error;
};

const STORAGE_REMOVE_ATTEMPTS = 2;

const removePrivateObjectsBestEffort = async (bucket: string, paths: string[]) => {
  const client = supabase;
  if (!client || paths.length === 0) return;
  await retryBestEffort(STORAGE_REMOVE_ATTEMPTS, async () => {
    const { error } = await client.storage.from(bucket).remove(paths);
    return !error;
  });
};

export const syncPhotoDeletions = async (ownerId: OwnerId, photoIds: string[]): Promise<string[]> => {
  if (!supabase || photoIds.length === 0) return [];
  await requireSessionOwner(ownerId);

  const completed: string[] = [];
  for (const photoId of photoIds) {
    await requireSessionOwner(ownerId);
    const deletedPhoto = await deleteCloudPhoto(photoId);
    const originalPath = deletedPhoto.originalPath ?? undefined;
    if (originalPath) {
      if (!originalPath.startsWith(`${ownerId}/`)) {
        throw new Error('The remote original belongs to a different account.');
      }
    }
    const assetPaths = deletedPhoto.layerAssetPaths;
    if (assetPaths.some((path) => !path.startsWith(`${ownerId}/`))) {
      throw new Error('A remote layer asset belongs to a different account.');
    }

    await Promise.all([
      removePrivateObjectsBestEffort('originals', originalPath ? [originalPath] : []),
      removePrivateObjectsBestEffort('derived', originalPath ? [
        `${originalPath.replace(/\/original\.[^/]+$/, '')}/analysis-proxy.jpg`,
        `${originalPath.replace(/\/original\.[^/]+$/, '')}/thumbnail.jpg`,
      ] : []),
      removePrivateObjectsBestEffort('layer-assets', assetPaths),
    ]);
    await clearPhotoDeletionId(photoId, ownerId);
    completed.push(photoId);
  }
  return completed;
};

export const syncStyleProfileDeletions = async (
  ownerId: OwnerId,
  styleIds: string[],
): Promise<string[]> => {
  if (styleIds.length === 0) return [];
  await requireSessionOwner(ownerId);
  const completed: string[] = [];
  for (const styleId of styleIds) {
    await requireSessionOwner(ownerId);
    await deleteCloudStyle(styleId);
    await clearStyleProfileDeletionId(styleId, ownerId);
    completed.push(styleId);
  }
  return completed;
};

export const syncQueuedPhotos = async (
  ownerId: OwnerId,
  photos: PhotoRecord[],
  onProgress?: (photos: PhotoRecord[]) => void,
): Promise<PhotoRecord[]> => {
  if (!supabase) return photos;
  const userId = await requireSessionOwner(ownerId);
  photos.forEach((photo) => assertOwnerMatches(photo.ownerId, ownerId));

  const synced = [...photos];
  for (let index = 0; index < synced.length; index += 1) {
    const photo = synced[index];
    if (photo.syncState === 'synced') continue;
    const base = `${userId}/${photo.id}`;
    try {
      await requireSessionOwner(ownerId);
      synced[index] = { ...photo, syncState: 'syncing' };
      onProgress?.([...synced]);
      const localOriginal = new File(photo.originalUri);
      const originalPath = photo.remoteOriginalPath
        ?? `${base}/original.${localOriginal.extension.replace('.', '') || 'jpg'}`;
      if (!originalPath.startsWith(`${ownerId}/`)) {
        throw new Error('The remote original belongs to a different account.');
      }
      if (localOriginal.exists) {
        await uploadOnce('originals', originalPath, photo.originalUri, photo.originalMimeType);
      } else if (!photo.remoteOriginalPath) {
        throw new Error('The local original is missing.');
      }
      await Promise.all([
        uploadOnce('derived', `${base}/analysis-proxy.jpg`, photo.analysisProxyUri, 'image/jpeg'),
        uploadOnce('derived', `${base}/thumbnail.jpg`, photo.thumbnailUri, 'image/jpeg'),
      ]);
      const layerAssets = layerAssetsForStacks(photo.versions.map((version) => version.stack));
      const cloudLayerAssets: CloudLayerAsset[] = [];
      for (const asset of layerAssets) {
        const file = new File(asset.uri);
        const storagePath = `${base}/layers/${asset.id}.${asset.mimeType === 'image/png' ? 'png' : 'jpg'}`;
        await uploadOnce('layer-assets', storagePath, asset.uri, asset.mimeType);
        cloudLayerAssets.push({
          id: asset.id,
          kind: asset.kind,
          storagePath,
          checksum: file.md5 ?? `${file.size}:${asset.id}`,
          mimeType: asset.mimeType,
        });
      }
      const cloudVersions: CloudPhotoVersion[] = photo.versions.map((version) => ({
        id: version.id,
        parentVersionId: version.parentVersionId,
        restoredFromVersionId: version.restoredFromVersionId,
        label: version.label,
        stack: version.stack,
        analysisProxyPath: `${base}/analysis-proxy.jpg`,
        thumbnailPath: `${base}/thumbnail.jpg`,
        createdAt: version.createdAt,
      }));
      await upsertCloudPhoto({
        id: photo.id,
        originalPath,
        originalName: photo.originalName,
        originalMimeType: photo.originalMimeType,
        originalByteSize: photo.originalByteSize,
        originalChecksum: photo.originalChecksum,
        captureSource: photo.captureSource,
        width: photo.width,
        height: photo.height,
        exif: photo.exif,
        currentVersionId: photo.currentVersionId,
        createdAt: photo.createdAt,
        versions: cloudVersions,
        layerAssets: cloudLayerAssets,
      });
      synced[index] = { ...photo, remoteOriginalPath: originalPath, syncState: 'synced' };
      onProgress?.([...synced]);
    } catch {
      synced[index] = { ...photo, syncState: 'failed' };
      onProgress?.([...synced]);
    }
  }
  return synced;
};

const exposureDirectory = new Directory(Paths.document, 'exposure');
const syncDirectoriesForOwner = (ownerId: OwnerId) => {
  const ownerDirectory = new Directory(exposureDirectory, 'owners', ownerDirectorySegment(ownerId));
  return {
    ownerDirectory,
    originalsDirectory: new Directory(ownerDirectory, 'originals'),
    proxiesDirectory: new Directory(ownerDirectory, 'proxies'),
    thumbnailsDirectory: new Directory(ownerDirectory, 'thumbnails'),
    layerAssetsDirectory: new Directory(ownerDirectory, 'layer-assets'),
  };
};

const ensureSyncDirectories = (ownerId: OwnerId) => {
  const directories = syncDirectoriesForOwner(ownerId);
  exposureDirectory.create({ intermediates: true, idempotent: true });
  directories.ownerDirectory.create({ intermediates: true, idempotent: true });
  directories.originalsDirectory.create({ intermediates: true, idempotent: true });
  directories.proxiesDirectory.create({ intermediates: true, idempotent: true });
  directories.thumbnailsDirectory.create({ intermediates: true, idempotent: true });
  directories.layerAssetsDirectory.create({ intermediates: true, idempotent: true });
  return directories;
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
  ownerId: OwnerId,
  photo: CloudPhoto,
): Promise<PhotoRecord> => {
  const { originalsDirectory, proxiesDirectory, thumbnailsDirectory, layerAssetsDirectory } = ensureSyncDirectories(ownerId);
  const original = new File(originalsDirectory, `${photo.id}.${extensionForPath(photo.originalPath)}`);
  const proxy = new File(proxiesDirectory, `${photo.id}.jpg`);
  const thumbnail = new File(thumbnailsDirectory, `${photo.id}.jpg`);
  const currentVersion = photo.versions.find((version) => version.id === photo.currentVersionId) ?? photo.versions.at(-1);

  await Promise.all([
    currentVersion?.analysisProxyPath ? Promise.resolve() : downloadPrivateObject('originals', photo.originalPath, original),
    currentVersion?.analysisProxyPath
      ? downloadPrivateObject('derived', currentVersion.analysisProxyPath, proxy)
      : Promise.resolve(),
    currentVersion?.thumbnailPath
      ? downloadPrivateObject('derived', currentVersion.thumbnailPath, thumbnail)
      : Promise.resolve(),
  ]);

  const assetUris = new Map<string, string>();
  await mapWithConcurrency(photo.layerAssets, 4, async (asset) => {
    const local = new File(layerAssetsDirectory, `${asset.id}.${extensionForPath(asset.storagePath, asset.mimeType === 'image/png' ? 'png' : 'jpg')}`);
    await downloadPrivateObject('layer-assets', asset.storagePath, local);
    assetUris.set(asset.id, local.uri);
  });

  const hydratedVersions: PhotoVersion[] = photo.versions
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .map((version) => ({
      id: version.id,
      photoId: photo.id,
      parentVersionId: version.parentVersionId ?? undefined,
      restoredFromVersionId: version.restoredFromVersionId ?? undefined,
      createdAt: version.createdAt,
      label: version.label,
      stack: {
        ...version.stack,
        layers: version.stack.layers.map((layer) => withLocalAssetUris(layer, assetUris)),
      },
    }));

  return {
    id: photo.id,
    ownerId,
    createdAt: photo.createdAt,
    captureSource: photo.captureSource,
    originalUri: original.uri,
    remoteOriginalPath: photo.originalPath,
    originalName: photo.originalName,
    originalMimeType: photo.originalMimeType,
    originalByteSize: Number(photo.originalByteSize),
    originalChecksum: photo.originalChecksum,
    analysisProxyUri: proxy.exists ? proxy.uri : original.uri,
    thumbnailUri: thumbnail.exists ? thumbnail.uri : proxy.exists ? proxy.uri : original.uri,
    width: photo.width ?? undefined,
    height: photo.height ?? undefined,
    exif: photo.exif,
    currentVersionId: photo.currentVersionId,
    versions: hydratedVersions,
    syncState: 'synced',
  };
};

/**
 * Pulls the private cloud library after sign-in so another device can rebuild
 * the same originals, version stacks, and generated/imported layer assets.
 */
export const pullRemotePhotos = async (
  ownerId: OwnerId,
  localPhotos: PhotoRecord[],
  excludedPhotoIds: string[] = [],
): Promise<PhotoRecord[]> => {
  if (!supabase) return localPhotos;
  localPhotos.forEach((photo) => assertOwnerMatches(photo.ownerId, ownerId));
  await requireSessionOwner(ownerId);

  const photoRows = await listCloudPhotos();
  const excluded = new Set(excludedPhotoIds);
  const visibleRows = photoRows.filter((row) => !excluded.has(row.id));
  if (!visibleRows.length) return localPhotos;

  const hydrationResults = await mapSettledWithConcurrency(visibleRows, 3, (photo) =>
    hydrateRemotePhoto(ownerId, photo));
  const remote = fulfilledValues(hydrationResults);

  const merged = new Map(localPhotos.map((photo) => [photo.id, photo]));
  for (const photo of remote) {
    const local = merged.get(photo.id);
    const hasUnsyncedLocalHistory = local && local.versions.some((version) => !photo.versions.some((remoteVersion) => remoteVersion.id === version.id));
    merged.set(photo.id, local && (local.syncState !== 'synced' || hasUnsyncedLocalHistory) ? local : photo);
  }
  return [...merged.values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
};

export const pullRemoteAnalyses = async (ownerId: OwnerId): Promise<Record<string, AnalysisResult>> => {
  await requireSessionOwner(ownerId);
  const data = await listCloudAnalyses();

  const analyses: Record<string, AnalysisResult> = {};
  for (const analysis of data) {
    if (!analyses[analysis.versionId]) analyses[analysis.versionId] = analysis;
  }
  return analyses;
};

export const pullRemoteStyles = async (ownerId: OwnerId) => {
  await requireSessionOwner(ownerId);
  const data = await listCloudStyles();
  await mergeStyleProfiles(data.map((row) => ({
    id: row.id,
    ownerId,
    name: row.name,
    referencePhotoIds: row.referencePhotoIds,
    palette: row.palette,
    adjustments: row.adjustments,
    mood: row.mood,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  })), ownerId);
};

export const pullRemotePreferences = async (ownerId: OwnerId) => {
  await requireSessionOwner(ownerId);
  const data = await getCloudPreferences();
  if (!data) return;
  const local = await loadPreferences(ownerId);
  await savePreferences({
    ...local,
    skillLevel: data.skillLevel,
    detail: data.feedbackDetail,
    desiredMood: data.desiredMood,
    exportMetadata: data.exportMetadata,
    exportGps: data.exportGps,
    recommendationFeedback: data.recommendationFeedback,
    camera: { ...local.camera, ...data.cameraPreferences },
  }, ownerId);
};

export const persistAnalysis = async (photo: PhotoRecord, analysis: AnalysisResult) => {
  if (photo.ownerId === GUEST_OWNER_ID) return;
  const ownerId = await requireSessionOwner(photo.ownerId);
  assertOwnerMatches(photo.ownerId, ownerId);
  await upsertCloudAnalysis(photo.id, analysis);
};

export const persistStyleProfile = async (style: StyleProfileResult, referencePhotoIds: string[]) => {
  const activeOwnerId = getActiveOwnerId();
  if (activeOwnerId === GUEST_OWNER_ID) return;
  await requireSessionOwner(activeOwnerId);
  const timestamps = style as StyleProfileResult & Partial<Pick<SavedStyleProfile, 'createdAt' | 'updatedAt'>>;
  await upsertCloudStyle(style, referencePhotoIds, timestamps);
};

export const persistPortfolioReview = async (review: PortfolioReview, selectedPhotoIds: string[]) => {
  const activeOwnerId = getActiveOwnerId();
  if (activeOwnerId === GUEST_OWNER_ID) return;
  await requireSessionOwner(activeOwnerId);
  await insertCloudPortfolioReview(review, selectedPhotoIds);
};

export const persistPreferences = async (
  preferences: ExposurePreferences,
  expectedOwnerId: OwnerId = getActiveOwnerId(),
) => {
  if (expectedOwnerId === GUEST_OWNER_ID) return;
  await requireSessionOwner(expectedOwnerId);
  await upsertCloudPreferences(preferences);
};
