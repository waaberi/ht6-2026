import AsyncStorage from '@react-native-async-storage/async-storage';

import type { StyleProfileResult } from '../services/api';

const STYLES_KEY = 'exposure.styles.v1';

export type SavedStyleProfile = StyleProfileResult & {
  referencePhotoIds: string[];
  createdAt: string;
};

export const loadStyleProfiles = async (): Promise<SavedStyleProfile[]> => {
  const serialized = await AsyncStorage.getItem(STYLES_KEY);
  if (!serialized) return [];
  try {
    return JSON.parse(serialized) as SavedStyleProfile[];
  } catch {
    return [];
  }
};

export const saveStyleProfile = async (style: StyleProfileResult, referencePhotoIds: string[]) => {
  const styles = await loadStyleProfiles();
  const saved: SavedStyleProfile = { ...style, referencePhotoIds, createdAt: new Date().toISOString() };
  await AsyncStorage.setItem(STYLES_KEY, JSON.stringify([saved, ...styles.filter((item) => item.id !== saved.id)]));
  return saved;
};

export const mergeStyleProfiles = async (remote: SavedStyleProfile[]) => {
  const local = await loadStyleProfiles();
  const merged = new Map(remote.map((style) => [style.id, style]));
  for (const style of local) merged.set(style.id, style);
  const styles = [...merged.values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  await AsyncStorage.setItem(STYLES_KEY, JSON.stringify(styles));
  return styles;
};
