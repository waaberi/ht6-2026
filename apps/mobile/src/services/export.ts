import { randomUUID } from 'expo-crypto';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

import { loadPreferences } from '../data/preferences';
import type { LayerStack, PhotoRecord } from '../domain/types';
import { requestRender } from './api';

export const exportAndShare = async (photo: PhotoRecord, stack: LayerStack) => {
  if (!(await Sharing.isAvailableAsync())) throw new Error('Android sharing is unavailable on this device.');
  const preferences = await loadPreferences();
  const rendered = await requestRender(photo, stack, {
    includeMetadata: preferences.exportMetadata,
    includeGps: preferences.exportMetadata && preferences.exportGps,
  });
  const output = new File(Paths.cache, `Exposure-${randomUUID()}.jpg`);
  output.write(new Uint8Array(await rendered.arrayBuffer()));
  await Sharing.shareAsync(output.uri, {
    mimeType: 'image/jpeg',
    dialogTitle: 'Share Exposure export',
    UTI: 'public.jpeg',
  });
  return output.uri;
};
