import AsyncStorage from '@react-native-async-storage/async-storage';

import { GUEST_OWNER_ID, ownerStorageSegment, type OwnerId } from '../domain/ownership';
import type { StyleProfileResult } from '../services/api';
import { getActiveOwnerId } from './ownerScope';

const LEGACY_STYLES_KEY = 'exposure.styles.v1';
const stylesKey = (ownerId: OwnerId) =>
  `exposure.owner.${ownerStorageSegment(ownerId)}.styles.v2`;

export type SavedStyleProfile = StyleProfileResult & {
  ownerId: OwnerId;
  referencePhotoIds: string[];
  createdAt: string;
};

export const loadStyleProfiles = async (ownerId: OwnerId = getActiveOwnerId()): Promise<SavedStyleProfile[]> => {
  const key = stylesKey(ownerId);
  let serialized = await AsyncStorage.getItem(key);
  if (!serialized && ownerId === GUEST_OWNER_ID) {
    const legacy = await AsyncStorage.getItem(LEGACY_STYLES_KEY);
    if (legacy) {
      try {
        const migrated = (JSON.parse(legacy) as Omit<SavedStyleProfile, 'ownerId'>[])
          .map((style) => ({ ...style, ownerId: GUEST_OWNER_ID }));
        serialized = JSON.stringify(migrated);
        await AsyncStorage.setItem(key, serialized);
      } catch {
        return [];
      }
    }
  }
  if (!serialized) return [];
  try {
    return (JSON.parse(serialized) as SavedStyleProfile[])
      .filter((style) => style.ownerId === ownerId);
  } catch {
    return [];
  }
};

export const saveStyleProfile = async (style: StyleProfileResult, referencePhotoIds: string[]) => {
  const ownerId = getActiveOwnerId();
  const styles = await loadStyleProfiles(ownerId);
  const saved: SavedStyleProfile = { ...style, ownerId, referencePhotoIds, createdAt: new Date().toISOString() };
  await AsyncStorage.setItem(stylesKey(ownerId), JSON.stringify([saved, ...styles.filter((item) => item.id !== saved.id)]));
  return saved;
};

export const mergeStyleProfiles = async (
  remote: SavedStyleProfile[],
  ownerId: OwnerId = getActiveOwnerId(),
) => {
  const local = await loadStyleProfiles(ownerId);
  if (remote.some((style) => style.ownerId !== ownerId)) {
    throw new Error('A style belongs to a different account.');
  }
  const merged = new Map(remote.map((style) => [style.id, style]));
  for (const style of local) merged.set(style.id, style);
  const styles = [...merged.values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  await AsyncStorage.setItem(stylesKey(ownerId), JSON.stringify(styles));
  return styles;
};
