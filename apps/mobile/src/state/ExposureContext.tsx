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
import { setActiveOwnerId } from '../data/ownerScope';
import { appendLayer, assertCurrentVersion, commitVersion, currentVersion, mergeCollectiveAdjustments, restoreVersion } from '../domain/layers';
import { GUEST_OWNER_ID, assertOwnerMatches, normalizeOwnerId, type OwnerId } from '../domain/ownership';
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
  ownerId: OwnerId;
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
  updatePhotoExif: (exif: Record<string, unknown>, expectedPhotoId?: string) => Promise<void>;
  restore: (versionId: string) => Promise<void>;
  runAnalysis: () => Promise<AnalysisResult>;
  synchronize: () => Promise<void>;
};

const ExposureContext = createContext<ExposureState | null>(null);

export const ExposureProvider = ({ children }: React.PropsWithChildren) => {
  const [ownerId, setOwnerId] = useState<OwnerId>(GUEST_OWNER_ID);
  const [photos, setPhotos] = useState<PhotoRecord[]>([]);
  const [selectedPhotoId, setSelectedPhotoId] = useState<string>();
  const [analyses, setAnalyses] = useState<Record<string, AnalysisResult>>({});
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string>();
  const [lastSyncedAt, setLastSyncedAt] = useState<string>();
  const photosRef = useRef<PhotoRecord[]>([]);
  const ownerIdRef = useRef<OwnerId>(GUEST_OWNER_ID);
  const ownerEpochRef = useRef(0);
  const ownerInitializedRef = useRef(false);
  const syncingRef = useRef(false);
  const syncAgainRef = useRef(false);

  const publishPhotos = useCallback((updated: PhotoRecord[], expectedOwnerId: OwnerId = ownerIdRef.current) => {
    if (ownerIdRef.current !== expectedOwnerId) return;
    updated.forEach((photo) => assertOwnerMatches(photo.ownerId, expectedOwnerId));
    photosRef.current = updated;
    setPhotos(updated);
    void savePhotos(updated, expectedOwnerId);
  }, []);

  const showPhotos = useCallback((updated: PhotoRecord[], expectedOwnerId: OwnerId = ownerIdRef.current) => {
    if (ownerIdRef.current !== expectedOwnerId) return;
    updated.forEach((photo) => assertOwnerMatches(photo.ownerId, expectedOwnerId));
    photosRef.current = updated;
    setPhotos(updated);
  }, []);

  const showSyncProgress = useCallback((expectedOwnerId: OwnerId, progress: PhotoRecord[]) => {
    if (ownerIdRef.current !== expectedOwnerId) return;
    showPhotos(mergeSyncProgress(expectedOwnerId, photosRef.current, progress), expectedOwnerId);
  }, [showPhotos]);

  const activateOwner = useCallback(async (nextOwnerId: string | null | undefined) => {
    const next = normalizeOwnerId(nextOwnerId);
    if (ownerInitializedRef.current && ownerIdRef.current === next) return;
    const epoch = ownerEpochRef.current + 1;
    ownerEpochRef.current = epoch;
    ownerIdRef.current = next;
    setActiveOwnerId(next);
    setLoading(true);
    photosRef.current = [];
    setPhotos([]);
    setSelectedPhotoId(undefined);
    setAnalyses({});
    setAnalyzing(false);
    setSyncError(undefined);
    setLastSyncedAt(undefined);
    syncingRef.current = false;
    syncAgainRef.current = false;
    setSyncing(false);

    const stored = await listPhotos(next);
    if (ownerEpochRef.current !== epoch) return;
    ownerInitializedRef.current = true;
    photosRef.current = stored;
    setOwnerId(next);
    setPhotos(stored);
    setSelectedPhotoId(stored[0]?.id);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!supabase) {
      void activateOwner(GUEST_OWNER_ID);
      return;
    }
    const subscription = supabase.auth.onAuthStateChange((_event, session) => {
      void activateOwner(session?.user.id);
    }).data.subscription;
    void supabase.auth.getSession().then(({ data }) => activateOwner(data.session?.user.id));
    return () => subscription.unsubscribe();
  }, [activateOwner]);

  const synchronize = useCallback(async function runSync() {
    if (loading || !supabase) return;
    if (syncingRef.current) {
      syncAgainRef.current = true;
      return;
    }
    const { data } = await supabase.auth.getSession();
    const syncOwnerId = ownerIdRef.current;
    const syncEpoch = ownerEpochRef.current;
    if (!data.session || data.session.user.id !== syncOwnerId) return;
    syncingRef.current = true;
    setSyncing(true);
    setSyncError(undefined);
    try {
      const pendingDeletions = await listPhotoDeletionIds(syncOwnerId);
      await syncPhotoDeletions(syncOwnerId, pendingDeletions);
      const uploaded = await syncQueuedPhotos(syncOwnerId, photosRef.current, (progress) => showSyncProgress(syncOwnerId, progress));
      const [hydrated, remoteAnalyses] = await Promise.all([
        pullRemotePhotos(syncOwnerId, uploaded, pendingDeletions),
        pullRemoteAnalyses(syncOwnerId),
        pullRemoteStyles(syncOwnerId),
        pullRemotePreferences(syncOwnerId),
      ]);
      if (ownerEpochRef.current !== syncEpoch || ownerIdRef.current !== syncOwnerId) return;
      const merged = mergeHydratedPhotos(syncOwnerId, photosRef.current, hydrated, await listPhotoDeletionIds(syncOwnerId));
      publishPhotos(merged, syncOwnerId);
      setAnalyses((current) => ({ ...remoteAnalyses, ...current }));
      setSelectedPhotoId((current) => current ?? merged[0]?.id);
      setLastSyncedAt(new Date().toISOString());
      if (uploaded.some((photo) => photo.syncState === 'failed')) {
        setSyncError('Some photos could not sync. Your local copies are safe; try again.');
      }
    } catch (error) {
      if (ownerEpochRef.current === syncEpoch) {
        setSyncError(error instanceof Error ? error.message : 'Cloud sync failed.');
      }
    } finally {
      if (ownerEpochRef.current !== syncEpoch) return;
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
    void NetInfo.fetch().then((network) => {
      if (network.isConnected) void synchronize();
    });
    return () => {
      unsubscribeNetwork();
    };
  }, [synchronize]);

  const selectedPhoto = photos.find((photo) => photo.id === selectedPhotoId);

  const liveSelectedPhoto = useCallback((expectedVersionId?: string) => {
    const photo = photosRef.current.find((candidate) => candidate.id === selectedPhotoId);
    if (!photo) throw new Error('Choose a photo first');
    assertOwnerMatches(photo.ownerId, ownerIdRef.current);
    assertCurrentVersion(photo, expectedVersionId);
    return photo;
  }, [selectedPhotoId]);

  const persistPhoto = useCallback(async (next: PhotoRecord) => {
    const expectedOwnerId = ownerIdRef.current;
    assertOwnerMatches(next.ownerId, expectedOwnerId);
    showPhotos(photosRef.current.map((photo) => (photo.id === next.id ? next : photo)), expectedOwnerId);
    await savePhoto(next, expectedOwnerId);
  }, [showPhotos]);

  const ingest = useCallback(async (input: IngestPhotoInput) => {
    const expectedOwnerId = ownerIdRef.current;
    const photo = await ingestPhoto(input, expectedOwnerId);
    if (ownerIdRef.current !== expectedOwnerId) return photo;
    showPhotos([photo, ...photosRef.current.filter((item) => item.id !== photo.id)], expectedOwnerId);
    setSelectedPhotoId(photo.id);
    void synchronize();
    return photo;
  }, [showPhotos, synchronize]);

  const deletePhotos = useCallback(async (photoIds: string[]) => {
    const expectedOwnerId = ownerIdRef.current;
    const ids = new Set(photoIds);
    const targets = photosRef.current.filter((photo) => ids.has(photo.id));
    if (targets.length === 0) return;
    targets.forEach((photo) => assertOwnerMatches(photo.ownerId, expectedOwnerId));
    await Promise.all(targets.map((photo) => deleteStoredPhoto(photo, expectedOwnerId)));
    if (ownerIdRef.current !== expectedOwnerId) return;
    const remaining = photosRef.current.filter((photo) => !ids.has(photo.id));
    showPhotos(remaining, expectedOwnerId);
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

  const updatePhotoExif = useCallback(async (exif: Record<string, unknown>, expectedPhotoId?: string) => {
    const photo = liveSelectedPhoto();
    if (expectedPhotoId && photo.id !== expectedPhotoId) throw new Error('The selected photo changed before metadata could be saved.');
    await persistPhoto({ ...photo, exif: { ...exif }, syncState: 'queued' });
    void synchronize();
  }, [liveSelectedPhoto, persistPhoto, synchronize]);

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
      ownerId,
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
      updatePhotoExif,
      restore,
      runAnalysis,
      synchronize,
    }),
    [ownerId, photos, selectedPhoto, analyses, loading, analyzing, syncing, syncError, lastSyncedAt, ingest, deletePhotos, addAdjustment, addLayer, commitStack, updatePhotoExif, restore, runAnalysis, synchronize],
  );

  return <ExposureContext.Provider value={value}>{children}</ExposureContext.Provider>;
};

export const useExposure = () => {
  const state = useContext(ExposureContext);
  if (!state) throw new Error('useExposure must be used within ExposureProvider');
  return state;
};
