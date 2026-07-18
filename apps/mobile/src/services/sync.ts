import { File } from 'expo-file-system';

import { layerAssetsForStacks } from '../domain/assets';
import type { ExposurePreferences } from '../data/preferences';
import type { AnalysisResult, PhotoRecord } from '../domain/types';
import type { PortfolioReview, StyleProfileResult } from './api';
import { supabase } from './supabase';

const uploadOnce = async (bucket: string, path: string, uri: string, contentType: string) => {
  if (!supabase) return;
  const bytes = await new File(uri).arrayBuffer();
  const { error } = await supabase.storage.from(bucket).upload(path, bytes, { contentType, upsert: false });
  if (error && !/already exists|duplicate/i.test(error.message)) throw error;
};

export const syncQueuedPhotos = async (photos: PhotoRecord[]): Promise<PhotoRecord[]> => {
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
      await uploadOnce('originals', `${base}/original.${new File(photo.originalUri).extension.replace('.', '') || 'jpg'}`, photo.originalUri, photo.originalMimeType);
      await Promise.all([
        uploadOnce('derived', `${base}/analysis-proxy.jpg`, photo.analysisProxyUri, 'image/jpeg'),
        uploadOnce('derived', `${base}/thumbnail.jpg`, photo.thumbnailUri, 'image/jpeg'),
      ]);
      const { error: photoError } = await supabase.from('photos').upsert({
        id: photo.id,
        owner_id: userId,
        original_path: `${base}/original.${new File(photo.originalUri).extension.replace('.', '') || 'jpg'}`,
        original_name: photo.originalName,
        original_mime_type: photo.originalMimeType,
        original_byte_size: photo.originalByteSize,
        original_checksum: photo.originalChecksum,
        capture_source: photo.captureSource,
        width: photo.width,
        height: photo.height,
        exif: photo.exif,
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
        layer_stack: version.stack.layers,
        analysis_proxy_path: `${base}/analysis-proxy.jpg`,
        thumbnail_path: `${base}/thumbnail.jpg`,
      })), { onConflict: 'id', ignoreDuplicates: true });
      if (versionsError) throw versionsError;
      const { error: currentError } = await supabase.from('photos').update({ current_version_id: photo.currentVersionId, sync_state: 'synced' }).eq('id', photo.id);
      if (currentError) throw currentError;
      synced[index] = { ...photo, syncState: 'synced' };
    } catch {
      synced[index] = { ...photo, syncState: 'failed' };
    }
  }
  return synced;
};

export const persistAnalysis = async (photo: PhotoRecord, analysis: AnalysisResult) => {
  if (!supabase) return;
  const { data } = await supabase.auth.getSession();
  const ownerId = data.session?.user.id;
  if (!ownerId) return;
  await supabase.from('analyses').upsert({
    owner_id: ownerId,
    photo_id: photo.id,
    version_id: photo.currentVersionId,
    checksum: analysis.checksum,
    schema_version: 'analysis-1',
    deterministic_model: analysis.deterministicModel,
    semantic_model: analysis.semanticModel,
    metrics: analysis.metrics,
    lighting: analysis.lighting,
    camera_recommendations: analysis.cameraRecommendations,
    issues: analysis.issues,
    summary: analysis.summary,
  }, { ignoreDuplicates: true });
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
  });
  if (error) throw error;
};
