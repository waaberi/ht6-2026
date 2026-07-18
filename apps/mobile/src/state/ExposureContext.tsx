import { randomUUID } from 'expo-crypto';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import {
  deletePhoto as deleteStoredPhoto,
  ingestPhoto,
  listPhotoDeletionIds,
  listPhotos,
  savePhoto,
  savePhotos,
  type IngestPhotoInput,
} from '../data/photoRepository';
import { appendLayer, assertCurrentVersion, commitVersion, currentVersion, mergeCollectiveAdjustments, restoreVersion } from '../domain/layers';
import { mergeHydratedPhotos, mergeSyncProgress } from '../domain/syncMerge';
import type { AdjustmentValues, AnalysisResult, Layer, LayerStack, PhotoRecord } from '../domain/types';
import { analyzePhoto } from '../services/api';
import { supabase } from '../services/supabase';
import {
  persistAnalysis,
  pullRemoteAnalyses,
  pullRemotePhotos,
  pullRemotePreferences,
  pullRemoteStyles,
  syncPhotoDeletions,
  syncQueuedPhotos,
} from '../services/sync';
import NetInfo from '@react-native-community/netinfo';

type ExposureState = {
  photos: PhotoRecord[];
  selectedPhoto?: PhotoRecord;
  analysis?: AnalysisResult;
  analyses: Record<string, AnalysisResult>;
  loading: boolean;
  analyzing: boolean;
  syncing: boolean;
  syncError?: string;
  lastSyncedAt?: string;
  selectPhoto: (photoId: string) => void;
  ingest: (input: IngestPhotoInput) => Promise<PhotoRecord>;
  deletePhotos: (photoIds: string[]) => Promise<void>;
  addAdjustment: (adjustments: AdjustmentValues, name?: string, expectedVersionId?: string) => Promise<void>;
  addLayer: (layer: Layer, label: string, expectedVersionId?: string) => Promise<void>;
  commitStack: (stack: LayerStack, label: string, expectedVersionId?: string) => Promise<void>;
  restore: (versionId: string) => Promise<void>;
  runAnalysis: () => Promise<AnalysisResult>;
  synchronize: () => Promise<void>;
};

const ExposureContext = createContext<ExposureState | null>(null);

export const ExposureProvider = ({ children }: React.PropsWithChildren) => {
  const [photos, setPhotos] = useState<PhotoRecord[]>([]);
  const [selectedPhotoId, setSelectedPhotoId] = useState<string>();
  const [analyses, setAnalyses] = useState<Record<string, AnalysisResult>>({});
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string>();
  const [lastSyncedAt, setLastSyncedAt] = useState<string>();
  const photosRef = useRef<PhotoRecord[]>([]);
  const syncingRef = useRef(false);
  const syncAgainRef = useRef(false);

  const publishPhotos = useCallback((updated: PhotoRecord[]) => {
    photosRef.current = updated;
    setPhotos(updated);
    void savePhotos(updated);
  }, []);

  const showPhotos = useCallback((updated: PhotoRecord[]) => {
    photosRef.current = updated;
    setPhotos(updated);
  }, []);

  const showSyncProgress = useCallback((progress: PhotoRecord[]) => {
    showPhotos(mergeSyncProgress(photosRef.current, progress));
  }, [showPhotos]);

  useEffect(() => {
    listPhotos()
      .then((stored) => {
        photosRef.current = stored;
        setPhotos(stored);
        setSelectedPhotoId(stored[0]?.id);
      })
      .finally(() => setLoading(false));
  }, []);

  const synchronize = useCallback(async function runSync() {
    if (loading || !supabase) return;
    if (syncingRef.current) {
      syncAgainRef.current = true;
      return;
    }
    const { data } = await supabase.auth.getSession();
    if (!data.session) return;
    syncingRef.current = true;
    setSyncing(true);
    setSyncError(undefined);
    try {
      const pendingDeletions = await listPhotoDeletionIds();
      await syncPhotoDeletions(pendingDeletions);
      const uploaded = await syncQueuedPhotos(photosRef.current, showSyncProgress);
      const [hydrated, remoteAnalyses] = await Promise.all([
        pullRemotePhotos(uploaded, pendingDeletions),
        pullRemoteAnalyses(),
        pullRemoteStyles(),
        pullRemotePreferences(),
      ]);
      const merged = mergeHydratedPhotos(photosRef.current, hydrated, await listPhotoDeletionIds());
      publishPhotos(merged);
      setAnalyses((current) => ({ ...remoteAnalyses, ...current }));
      setSelectedPhotoId((current) => current ?? merged[0]?.id);
      setLastSyncedAt(new Date().toISOString());
      if (uploaded.some((photo) => photo.syncState === 'failed')) {
        setSyncError('Some photos could not sync. Your local copies are safe; try again.');
      }
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Cloud sync failed.');
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      if (syncAgainRef.current) {
        syncAgainRef.current = false;
        setTimeout(() => void runSync(), 0);
      }
    }
  }, [loading, publishPhotos, showSyncProgress]);

  useEffect(() => {
    const unsubscribeNetwork = NetInfo.addEventListener((network) => {
      if (network.isConnected) void synchronize();
    });
    const authSubscription = supabase?.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') void synchronize();
    }).data.subscription;
    void NetInfo.fetch().then((network) => {
      if (network.isConnected) void synchronize();
    });
    return () => {
      unsubscribeNetwork();
      authSubscription?.unsubscribe();
    };
  }, [synchronize]);

  const selectedPhoto = photos.find((photo) => photo.id === selectedPhotoId);

  const liveSelectedPhoto = useCallback((expectedVersionId?: string) => {
    const photo = photosRef.current.find((candidate) => candidate.id === selectedPhotoId);
    if (!photo) throw new Error('Choose a photo first');
    assertCurrentVersion(photo, expectedVersionId);
    return photo;
  }, [selectedPhotoId]);

  const persistPhoto = useCallback(async (next: PhotoRecord) => {
    showPhotos(photosRef.current.map((photo) => (photo.id === next.id ? next : photo)));
    await savePhoto(next);
  }, [showPhotos]);

  const ingest = useCallback(async (input: IngestPhotoInput) => {
    const photo = await ingestPhoto(input);
    showPhotos([photo, ...photosRef.current.filter((item) => item.id !== photo.id)]);
    setSelectedPhotoId(photo.id);
    void synchronize();
    return photo;
  }, [showPhotos, synchronize]);

  const deletePhotos = useCallback(async (photoIds: string[]) => {
    const ids = new Set(photoIds);
    const targets = photosRef.current.filter((photo) => ids.has(photo.id));
    if (targets.length === 0) return;
    await Promise.all(targets.map(deleteStoredPhoto));
    const remaining = photosRef.current.filter((photo) => !ids.has(photo.id));
    showPhotos(remaining);
    setSelectedPhotoId((current) => current && ids.has(current) ? remaining[0]?.id : current);
    void synchronize();
  }, [showPhotos, synchronize]);

  const addLayer = useCallback(
    async (layer: Layer, label: string, expectedVersionId?: string) => {
      const photo = liveSelectedPhoto(expectedVersionId);
      const stack = appendLayer(currentVersion(photo).stack, layer);
      await persistPhoto(commitVersion(photo, randomUUID(), stack, label));
      void synchronize();
    },
    [liveSelectedPhoto, persistPhoto, synchronize],
  );

  const commitStack = useCallback(
    async (stack: LayerStack, label: string, expectedVersionId?: string) => {
      const photo = liveSelectedPhoto(expectedVersionId);
      await persistPhoto(commitVersion(photo, randomUUID(), stack, label));
      void synchronize();
    },
    [liveSelectedPhoto, persistPhoto, synchronize],
  );

  const addAdjustment = useCallback(
    async (adjustments: AdjustmentValues, name = 'Manual adjustment', expectedVersionId?: string) => {
      const photo = liveSelectedPhoto(expectedVersionId);
      const stack = mergeCollectiveAdjustments(currentVersion(photo).stack, adjustments);
      await persistPhoto(commitVersion(photo, randomUUID(), stack, name));
      void synchronize();
    },
    [liveSelectedPhoto, persistPhoto, synchronize],
  );

  const restore = useCallback(
    async (versionId: string) => {
      const photo = liveSelectedPhoto();
      await persistPhoto(restoreVersion(photo, versionId, randomUUID()));
      void synchronize();
    },
    [liveSelectedPhoto, persistPhoto, synchronize],
  );

  const runAnalysis = useCallback(async () => {
    const photo = liveSelectedPhoto();
    const sourceVersionId = photo.currentVersionId;
    setAnalyzing(true);
    try {
      const result = await analyzePhoto(photo);
      const livePhoto = photosRef.current.find((candidate) => candidate.id === photo.id);
      if (!livePhoto) throw new Error('The analyzed photo is no longer available.');
      assertCurrentVersion(livePhoto, sourceVersionId);
      setAnalyses((current) => ({ ...current, [sourceVersionId]: result }));
      void persistAnalysis(photo, result).catch((error: unknown) => {
        setSyncError(error instanceof Error ? error.message : 'Analysis could not sync.');
      });
      return result;
    } finally {
      setAnalyzing(false);
    }
  }, [liveSelectedPhoto]);

  const value = useMemo<ExposureState>(
    () => ({
      photos,
      selectedPhoto,
      analysis: selectedPhoto ? analyses[selectedPhoto.currentVersionId] : undefined,
      analyses,
      loading,
      analyzing,
      syncing,
      syncError,
      lastSyncedAt,
      selectPhoto: setSelectedPhotoId,
      ingest,
      deletePhotos,
      addAdjustment,
      addLayer,
      commitStack,
      restore,
      runAnalysis,
      synchronize,
    }),
    [photos, selectedPhoto, analyses, loading, analyzing, syncing, syncError, lastSyncedAt, ingest, deletePhotos, addAdjustment, addLayer, commitStack, restore, runAnalysis, synchronize],
  );

  return <ExposureContext.Provider value={value}>{children}</ExposureContext.Provider>;
};

export const useExposure = () => {
  const state = useContext(ExposureContext);
  if (!state) throw new Error('useExposure must be used within ExposureProvider');
  return state;
};
