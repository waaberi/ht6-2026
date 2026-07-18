import { File } from 'expo-file-system';

import type { PhotoRecord } from '../domain/types';
import { supabase } from './supabase';

export const ensureLocalOriginal = async (photo: PhotoRecord) => {
  const local = new File(photo.originalUri);
  if (local.exists) return local;
  if (!supabase || !photo.remoteOriginalPath) throw new Error('The original is not available on this device.');
  const { data, error } = await supabase.storage.from('originals').createSignedUrl(photo.remoteOriginalPath, 10 * 60);
  if (error) throw error;
  await File.downloadFileAsync(data.signedUrl, local, { idempotent: true });
  return local;
};
