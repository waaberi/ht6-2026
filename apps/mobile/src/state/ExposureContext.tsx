import { randomUUID } from 'expo-crypto';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import { ingestPhoto, listPhotos, savePhotos, type IngestPhotoInput } from '../data/photoRepository';
import { appendLayer, commitVersion, currentVersion, makeAdjustmentLayer, restoreVersion } from '../domain/layers';
import type { AdjustmentValues, AnalysisResult, Layer, LayerStack, PhotoRecord } from '../domain/types';
import { analyzePhoto } from '../services/api';
import { supabase } from '../services/supabase';
import { persistAnalysis, syncQueuedPhotos } from '../services/sync';
import NetInfo from '@react-native-community/netinfo';

type ExposureState = {
  photos: PhotoRecord[];
  selectedPhoto?: PhotoRecord;
  analysis?: AnalysisResult;
  analyses: Record<string, AnalysisResult>;
  loading: boolean;
  analyzing: boolean;
  selectPhoto: (photoId: string) => void;
  ingest: (input: IngestPhotoInput) => Promise<PhotoRecord>;
  addAdjustment: (adjustments: AdjustmentValues, name?: string) => Promise<void>;
  addLayer: (layer: Layer, label: string) => Promise<void>;
  commitStack: (stack: LayerStack, label: string) => Promise<void>;
  restore: (versionId: string) => Promise<void>;
  runAnalysis: () => Promise<AnalysisResult>;
};

const ExposureContext = createContext<ExposureState | null>(null);

export const ExposureProvider = ({ children }: React.PropsWithChildren) => {
  const [photos, setPhotos] = useState<PhotoRecord[]>([]);
  const [selectedPhotoId, setSelectedPhotoId] = useState<string>();
  const [analyses, setAnalyses] = useState<Record<string, AnalysisResult>>({});
  const [loading, setLoading] = useState(true);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    listPhotos()
      .then((stored) => {
        setPhotos(stored);
        setSelectedPhotoId(stored[0]?.id);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    const synchronize = () => {
      if (!photos.some((photo) => photo.syncState !== 'synced')) return;
      void syncQueuedPhotos(photos).then((updated) => {
        if (JSON.stringify(updated) !== JSON.stringify(photos)) {
          setPhotos(updated);
          void savePhotos(updated);
        }
      });
    };
    const unsubscribeNetwork = NetInfo.addEventListener((network) => {
      if (network.isConnected) synchronize();
    });
    const authSubscription = supabase?.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') synchronize();
    }).data.subscription;
    return () => {
      unsubscribeNetwork();
      authSubscription?.unsubscribe();
    };
  }, [photos]);

  const selectedPhoto = photos.find((photo) => photo.id === selectedPhotoId);

  const persistPhoto = useCallback(async (next: PhotoRecord) => {
    setPhotos((current) => {
      const updated = current.map((photo) => (photo.id === next.id ? next : photo));
      void savePhotos(updated);
      return updated;
    });
  }, []);

  const ingest = useCallback(async (input: IngestPhotoInput) => {
    const photo = await ingestPhoto(input);
    setPhotos((current) => [photo, ...current.filter((item) => item.id !== photo.id)]);
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
      await addLayer(makeAdjustmentLayer(randomUUID(), adjustments, name), name);
    },
    [addLayer],
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
      selectPhoto: setSelectedPhotoId,
      ingest,
      addAdjustment,
      addLayer,
      commitStack,
      restore,
      runAnalysis,
    }),
    [photos, selectedPhoto, analyses, loading, analyzing, ingest, addAdjustment, addLayer, commitStack, restore, runAnalysis],
  );

  return <ExposureContext.Provider value={value}>{children}</ExposureContext.Provider>;
};

export const useExposure = () => {
  const state = useContext(ExposureContext);
  if (!state) throw new Error('useExposure must be used within ExposureProvider');
  return state;
};
