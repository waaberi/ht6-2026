import AsyncStorage from '@react-native-async-storage/async-storage';

import { GUEST_OWNER_ID, ownerStorageSegment, type OwnerId } from '../domain/ownership';
import type { StyleProfileResult } from '../services/api';
import { getActiveOwnerId } from './ownerScope';

const LEGACY_STYLES_KEY = 'exposure.styles.v1';
const stylesKey = (ownerId: OwnerId) =>
  `exposure.owner.${ownerStorageSegment(ownerId)}.styles.v2`;
const styleDeletionsKey = (ownerId: OwnerId) =>
  `exposure.owner.${ownerStorageSegment(ownerId)}.style-deletions.v1`;

export type SavedStyleProfile = StyleProfileResult & {
  ownerId: OwnerId;
  referencePhotoIds: string[];
  createdAt: string;
  updatedAt?: string;
  isBuiltIn?: boolean;
};

const BUILT_IN_CREATED_AT = '2026-01-01T00:00:00.000Z';
const BUILT_IN_STYLES: Array<Omit<SavedStyleProfile, 'ownerId'>> = [
  {
    id: 'builtin-monotone',
    name: 'Monotone',
    adjustments: { saturation: -1, contrast: 0.12, shadows: 0.08, grain: 0.08 },
    palette: [],
    mood: 'Balanced black and white',
    referencePhotoIds: [],
    createdAt: BUILT_IN_CREATED_AT,
    updatedAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: 'builtin-vibrant',
    name: 'Vibrant',
    adjustments: { vibrance: 0.5, saturation: 0.16, contrast: 0.1 },
    palette: [],
    mood: 'Bold color with a clean punch',
    referencePhotoIds: [],
    createdAt: BUILT_IN_CREATED_AT,
    updatedAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: 'builtin-golden-hour',
    name: 'Golden Hour',
    adjustments: { temperature: 0.32, highlights: -0.12, shadows: 0.14, vibrance: 0.16 },
    palette: [],
    mood: 'Warm, glowing evening light',
    referencePhotoIds: [],
    createdAt: BUILT_IN_CREATED_AT,
    updatedAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: 'builtin-soft-film',
    name: 'Soft Film',
    adjustments: { contrast: -0.12, highlights: -0.24, shadows: 0.2, grain: 0.16, vignette: 0.1 },
    palette: [],
    mood: 'Gentle contrast with fine grain',
    referencePhotoIds: [],
    createdAt: BUILT_IN_CREATED_AT,
    updatedAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: 'builtin-noir',
    name: 'Noir',
    adjustments: { saturation: -1, contrast: 0.38, shadows: -0.16, highlights: -0.08, grain: 0.2 },
    palette: [],
    mood: 'Deep, dramatic black and white',
    referencePhotoIds: [],
    createdAt: BUILT_IN_CREATED_AT,
    updatedAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
  {
    id: 'builtin-crisp',
    name: 'Crisp',
    adjustments: { exposure: 0.08, highlights: -0.16, shadows: 0.16, sharpening: 0.28, denoise: 0.08 },
    palette: [],
    mood: 'Bright detail with controlled highlights',
    referencePhotoIds: [],
    createdAt: BUILT_IN_CREATED_AT,
    updatedAt: BUILT_IN_CREATED_AT,
    isBuiltIn: true,
  },
];

const builtInStyleProfiles = (ownerId: OwnerId): SavedStyleProfile[] =>
  BUILT_IN_STYLES.map((style) => ({ ...style, ownerId }));

const loadStoredStyleProfiles = async (ownerId: OwnerId): Promise<SavedStyleProfile[]> => {
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
      .filter((style) => style.ownerId === ownerId && !style.isBuiltIn)
      .map((style) => ({ ...style, updatedAt: style.updatedAt ?? style.createdAt }));
  } catch {
    return [];
  }
};

export const listStyleProfileDeletionIds = async (ownerId: OwnerId = getActiveOwnerId()): Promise<string[]> => {
  const serialized = await AsyncStorage.getItem(styleDeletionsKey(ownerId));
  if (!serialized) return [];
  try {
    return [...new Set(JSON.parse(serialized) as string[])];
  } catch {
    return [];
  }
};

export const clearStyleProfileDeletionId = async (
  styleId: string,
  ownerId: OwnerId = getActiveOwnerId(),
) => {
  const deletionIds = await listStyleProfileDeletionIds(ownerId);
  await AsyncStorage.setItem(
    styleDeletionsKey(ownerId),
    JSON.stringify(deletionIds.filter((id) => id !== styleId)),
  );
};

export const loadStyleProfiles = async (ownerId: OwnerId = getActiveOwnerId()): Promise<SavedStyleProfile[]> => [
  ...builtInStyleProfiles(ownerId),
  ...await loadStoredStyleProfiles(ownerId),
];

export const saveStyleProfile = async (style: StyleProfileResult, referencePhotoIds: string[]) => {
  const ownerId = getActiveOwnerId();
  const styles = await loadStoredStyleProfiles(ownerId);
  const now = new Date().toISOString();
  const saved: SavedStyleProfile = {
    ...style,
    ownerId,
    referencePhotoIds,
    createdAt: now,
    updatedAt: now,
    isBuiltIn: false,
  };
  await AsyncStorage.setItem(stylesKey(ownerId), JSON.stringify([saved, ...styles.filter((item) => item.id !== saved.id)]));
  return saved;
};

export const renameStyleProfile = async (
  styleId: string,
  name: string,
  ownerId: OwnerId = getActiveOwnerId(),
) => {
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('Enter a name for this preset.');
  const styles = await loadStoredStyleProfiles(ownerId);
  const existing = styles.find((style) => style.id === styleId);
  if (!existing) throw new Error('This preset could not be found.');
  const updated = { ...existing, name: trimmedName.slice(0, 40), updatedAt: new Date().toISOString() };
  await AsyncStorage.setItem(
    stylesKey(ownerId),
    JSON.stringify(styles.map((style) => style.id === styleId ? updated : style)),
  );
  return updated;
};

export const deleteStyleProfile = async (
  styleId: string,
  ownerId: OwnerId = getActiveOwnerId(),
) => {
  const styles = await loadStoredStyleProfiles(ownerId);
  const existing = styles.find((style) => style.id === styleId);
  if (!existing) throw new Error('This preset could not be found.');
  const writes: Promise<void>[] = [
    AsyncStorage.setItem(
      stylesKey(ownerId),
      JSON.stringify(styles.filter((style) => style.id !== styleId)),
    ),
  ];
  if (ownerId !== GUEST_OWNER_ID) {
    const deletionIds = await listStyleProfileDeletionIds(ownerId);
    writes.push(AsyncStorage.setItem(
      styleDeletionsKey(ownerId),
      JSON.stringify([...new Set([...deletionIds, styleId])]),
    ));
  }
  await Promise.all(writes);
  return existing;
};

export const mergeStyleProfiles = async (
  remote: SavedStyleProfile[],
  ownerId: OwnerId = getActiveOwnerId(),
) => {
  const local = await loadStoredStyleProfiles(ownerId);
  const deletedIds = new Set(await listStyleProfileDeletionIds(ownerId));
  if (remote.some((style) => style.ownerId !== ownerId)) {
    throw new Error('A style belongs to a different account.');
  }
  const merged = new Map(remote
    .filter((style) => !style.isBuiltIn && !deletedIds.has(style.id))
    .map((style) => [style.id, style]));
  for (const style of local) {
    const existing = merged.get(style.id);
    const localUpdatedAt = Date.parse(style.updatedAt ?? style.createdAt);
    const remoteUpdatedAt = existing ? Date.parse(existing.updatedAt ?? existing.createdAt) : Number.NEGATIVE_INFINITY;
    if (!existing || localUpdatedAt >= remoteUpdatedAt) merged.set(style.id, style);
  }
  const styles = [...merged.values()].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
  await AsyncStorage.setItem(stylesKey(ownerId), JSON.stringify(styles));
  return styles;
};
