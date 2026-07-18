import { randomUUID } from 'expo-crypto';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { ingestPhoto, listPhotos, savePhotos, type IngestPhotoInput } from '../data/photoRepository';
import { appendLayer, commitVersion, currentVersion, mergeCollectiveAdjustments, restoreVersion } from '../domain/layers';
import type { AdjustmentValues, AnalysisResult, Layer, LayerStack, PhotoRecord } from '../domain/types';
import { analyzePhoto } from '../services/api';
import { supabase } from '../services/supabase';
import { persistAnalysis, pullRemoteAnalyses, pullRemotePhotos, pullRemotePreferences, pullRemoteStyles, syncQueuedPhotos } from '../services/sync';
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
  addAdjustment: (adjustments: AdjustmentValues, name?: string) => Promise<void>;
  addLayer: (layer: Layer, label: string) => Promise<void>;
  commitStack: (stack: LayerStack, label: string) => Promise<void>;
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

  const publishPhotos = useCallback((updated: PhotoRecord[]) => {
    photosRef.current = updated;
    setPhotos(updated);
    void savePhotos(updated);
  }, []);

  useEffect(() => {
    listPhotos()
      .then((stored) => {
        photosRef.current = stored;
        setPhotos(stored);
        setSelectedPhotoId(stored[0]?.id);
      })
      .finally(() => setLoading(false));
  }, []);

  const synchronize = useCallback(async () => {
    if (loading || syncingRef.current || !supabase) return;
    const { data } = await supabase.auth.getSession();
    if (!data.session) return;
    syncingRef.current = true;
    setSyncing(true);
    setSyncError(undefined);
    try {
      const uploaded = await syncQueuedPhotos(photosRef.current, publishPhotos);
      const [hydrated, remoteAnalyses] = await Promise.all([
        pullRemotePhotos(uploaded),
        pullRemoteAnalyses(),
        pullRemoteStyles(),
        pullRemotePreferences(),
      ]);
      publishPhotos(hydrated);
      setAnalyses((current) => ({ ...remoteAnalyses, ...current }));
      setSelectedPhotoId((current) => current ?? hydrated[0]?.id);
      setLastSyncedAt(new Date().toISOString());
      if (uploaded.some((photo) => photo.syncState === 'failed')) {
        setSyncError('Some photos could not sync. Your local copies are safe; try again.');
      }
    } catch (error) {
      setSyncError(error instanceof Error ? error.message : 'Cloud sync failed.');
    } finally {
      syncingRef.current = false;
      setSyncing(false);
    }
  }, [loading, publishPhotos]);

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

  const persistPhoto = useCallback(async (next: PhotoRecord) => {
    setPhotos((current) => {
      const updated = current.map((photo) => (photo.id === next.id ? next : photo));
      photosRef.current = updated;
      void savePhotos(updated);
      return updated;
    });
  }, []);

  const ingest = useCallback(async (input: IngestPhotoInput) => {
    const photo = await ingestPhoto(input);
    setPhotos((current) => {
      const updated = [photo, ...current.filter((item) => item.id !== photo.id)];
      photosRef.current = updated;
      return updated;
    });
    setSelectedPhotoId(photo.id);
    return photo;
  }, []);

  const addLayer = useCallback(
    async (layer: Layer, label: string) => {
      if (!selectedPhoto) throw new Error('Choose a photo first');
      const stack = appendLayer(currentVersion(selectedPhoto).stack, layer);
      await persistPhoto(commitVersion(selectedPhoto, randomUUID(), stack, label));
    },
    [persistPhoto, selectedPhoto],
  );

  const commitStack = useCallback(
    async (stack: LayerStack, label: string) => {
      if (!selectedPhoto) throw new Error('Choose a photo first');
      await persistPhoto(commitVersion(selectedPhoto, randomUUID(), stack, label));
    },
    [persistPhoto, selectedPhoto],
  );

  const addAdjustment = useCallback(
    async (adjustments: AdjustmentValues, name = 'Manual adjustment') => {
      if (!selectedPhoto) throw new Error('Choose a photo first');
      const stack = mergeCollectiveAdjustments(currentVersion(selectedPhoto).stack, adjustments);
      await persistPhoto(commitVersion(selectedPhoto, randomUUID(), stack, name));
    },
    [persistPhoto, selectedPhoto],
  );

  const restore = useCallback(
    async (versionId: string) => {
      if (!selectedPhoto) throw new Error('Choose a photo first');
      await persistPhoto(restoreVersion(selectedPhoto, versionId, randomUUID()));
    },
    [persistPhoto, selectedPhoto],
  );

  const runAnalysis = useCallback(async () => {
    if (!selectedPhoto) throw new Error('Choose a photo first');
    setAnalyzing(true);
    try {
      const result = await analyzePhoto(selectedPhoto);
      setAnalyses((current) => ({ ...current, [selectedPhoto.currentVersionId]: result }));
      void persistAnalysis(selectedPhoto, result);
      return result;
    } finally {
      setAnalyzing(false);
    }
  }, [selectedPhoto]);

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
      addAdjustment,
      addLayer,
      commitStack,
      restore,
      runAnalysis,
      synchronize,
    }),
    [photos, selectedPhoto, analyses, loading, analyzing, syncing, syncError, lastSyncedAt, ingest, addAdjustment, addLayer, commitStack, restore, runAnalysis, synchronize],
  );

  return <ExposureContext.Provider value={value}>{children}</ExposureContext.Provider>;
};

export const useExposure = () => {
  const state = useContext(ExposureContext);
  if (!state) throw new Error('useExposure must be used within ExposureProvider');
  return state;
};
