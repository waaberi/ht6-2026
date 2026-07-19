import { File } from 'expo-file-system';

import { getActiveOwnerId } from '../data/ownerScope';
import { assertAuthenticatedOwner, assertOwnerMatches } from '../domain/ownership';
import type { PhotoRecord } from '../domain/types';
import { getCurrentAuthUser } from './auth';
import { supabase } from './supabase';

export const ensureLocalOriginal = async (photo: PhotoRecord) => {
  const activeOwnerId = getActiveOwnerId();
  assertOwnerMatches(photo.ownerId, activeOwnerId);
  const local = new File(photo.originalUri);
  if (local.exists) return local;
  if (!supabase || !photo.remoteOriginalPath) throw new Error('The original is not available on this device.');
  assertAuthenticatedOwner(photo.ownerId, getCurrentAuthUser()?.sub);
  if (!photo.remoteOriginalPath.startsWith(`${photo.ownerId}/`)) {
    throw new Error('The remote original belongs to a different account.');
  }
  const { data, error } = await supabase.storage.from('originals').createSignedUrl(photo.remoteOriginalPath, 10 * 60);
  if (error) throw error;
  await File.downloadFileAsync(data.signedUrl, local, { idempotent: true });
  return local;
};
