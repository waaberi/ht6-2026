import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { layerAssetsForStacks } from '../domain/assets';
import { emptyLayerStack } from '../domain/layers';
import type { PhotoRecord } from '../domain/types';

const PHOTO_INDEX_KEY = 'exposure.photos.index.v2';
const PHOTO_DELETIONS_KEY = 'exposure.photos.deletions.v1';
const LEGACY_PHOTOS_KEY = 'exposure.photos.v1';
const photoKey = (id: string) => `exposure.photo.v2.${id}`;
let persistenceQueue = Promise.resolve();

const serializeWrite = <T,>(work: () => Promise<T>) => {
  const pending = persistenceQueue.then(work, work);
  persistenceQueue = pending.then(() => undefined, () => undefined);
  return pending;
};
const exposureDirectory = new Directory(Paths.document, 'exposure');
const originalsDirectory = new Directory(exposureDirectory, 'originals');
const proxiesDirectory = new Directory(exposureDirectory, 'proxies');
const thumbnailsDirectory = new Directory(exposureDirectory, 'thumbnails');
const layerAssetsDirectory = new Directory(exposureDirectory, 'layer-assets');

const readExif = async (bytes: ArrayBuffer) => {
  // React Native exposes `navigator` without a userAgent. exifr inspects that
  // field while its module is evaluated, so load it lazily after supplying the
  // missing runtime value instead of crashing the app at startup.
  if (typeof globalThis.navigator === 'object' && typeof globalThis.navigator.userAgent !== 'string') {
    Object.defineProperty(globalThis.navigator, 'userAgent', {
      configurable: true,
      value: 'ReactNative',
    });
  }
  const { default: exifr } = await import('exifr/dist/lite.esm.js');
  return exifr.parse(bytes, {
    tiff: true, exif: true, gps: true, interop: true, makerNote: false,
    xmp: false, icc: false, iptc: false, jfif: false, mergeOutput: true, sanitize: true,
  });
};

const ensureDirectories = () => {
  exposureDirectory.create({ intermediates: true, idempotent: true });
  originalsDirectory.create({ intermediates: true, idempotent: true });
  proxiesDirectory.create({ intermediates: true, idempotent: true });
  thumbnailsDirectory.create({ intermediates: true, idempotent: true });
  layerAssetsDirectory.create({ intermediates: true, idempotent: true });
};

const extensionFor = (name: string, mimeType: string) => {
  const supplied = name.match(/\.(jpe?g|png|heic)$/i)?.[1]?.toLowerCase();
  if (supplied === 'jpeg') return 'jpg';
  if (supplied) return supplied;
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/heic' || mimeType === 'image/heif') return 'heic';
  return 'jpg';
};

const createDerivedImage = async (sourceUri: string, target: File, maxWidth: number, quality: number) => {
  try {
    const context = ImageManipulator.manipulate(sourceUri);
    context.resize({ width: maxWidth, height: null });
    const rendered = await context.renderAsync();
    const saved = await rendered.saveAsync({ compress: quality, format: SaveFormat.JPEG });
    const temporary = new File(saved.uri);
    await temporary.copy(target);
    temporary.delete();
  } catch {
    // Some Android decoders cannot resize HEIC. A private derived copy still
    // keeps the immutable original isolated and lets the backend create proxies.
    await new File(sourceUri).copy(target);
  }
};

export type IngestPhotoInput = {
  uri: string;
  name: string;
  mimeType?: string;
  source: PhotoRecord['captureSource'];
  width?: number;
  height?: number;
  exif?: Record<string, unknown> | null;
};

export const listPhotos = async (): Promise<PhotoRecord[]> => {
  let serialized = await AsyncStorage.getItem(PHOTO_INDEX_KEY);
  if (!serialized) {
    const legacy = await AsyncStorage.getItem(LEGACY_PHOTOS_KEY);
    if (!legacy) return [];
    try {
      const photos = JSON.parse(legacy) as PhotoRecord[];
      await savePhotos(photos);
      return photos;
    } catch {
      return [];
    }
  }
  try {
    const ids = JSON.parse(serialized) as string[];
    const rows = await AsyncStorage.multiGet(ids.map(photoKey));
    return rows.flatMap(([, value]) => {
      if (!value) return [];
      try {
        return [JSON.parse(value) as PhotoRecord];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
};

export const savePhotos = (photos: PhotoRecord[]) => serializeWrite(async () => {
  await AsyncStorage.multiSet([
    [PHOTO_INDEX_KEY, JSON.stringify(photos.map((photo) => photo.id))],
    ...photos.map((photo) => [photoKey(photo.id), JSON.stringify(photo)] as [string, string]),
  ]);
});

export const savePhoto = (photo: PhotoRecord) => serializeWrite(() =>
  AsyncStorage.setItem(photoKey(photo.id), JSON.stringify(photo)));

export const listPhotoDeletionIds = async (): Promise<string[]> => {
  const serialized = await AsyncStorage.getItem(PHOTO_DELETIONS_KEY);
  if (!serialized) return [];
  try {
    return JSON.parse(serialized) as string[];
  } catch {
    return [];
  }
};

export const clearPhotoDeletionId = (photoId: string) => serializeWrite(async () => {
  const ids = await listPhotoDeletionIds();
  await AsyncStorage.setItem(PHOTO_DELETIONS_KEY, JSON.stringify(ids.filter((id) => id !== photoId)));
});

const deleteLocalFile = (uri: string | undefined) => {
  if (!uri?.startsWith('file:')) return;
  const file = new File(uri);
  if (file.exists) file.delete();
};

export const deletePhoto = (photo: PhotoRecord) => serializeWrite(async () => {
  const [serializedIndex, deletedIds] = await Promise.all([
    AsyncStorage.getItem(PHOTO_INDEX_KEY),
    listPhotoDeletionIds(),
  ]);
  const ids = serializedIndex ? JSON.parse(serializedIndex) as string[] : [];
  await AsyncStorage.multiSet([
    [PHOTO_INDEX_KEY, JSON.stringify(ids.filter((id) => id !== photo.id))],
    [PHOTO_DELETIONS_KEY, JSON.stringify([...new Set([...deletedIds, photo.id])])],
  ]);
  await AsyncStorage.removeItem(photoKey(photo.id));

  deleteLocalFile(photo.originalUri);
  deleteLocalFile(photo.analysisProxyUri);
  deleteLocalFile(photo.thumbnailUri);
  const assets = layerAssetsForStacks(photo.versions.map((version) => version.stack));
  for (const asset of assets) deleteLocalFile(asset.uri);
});

const prependPhoto = (photo: PhotoRecord) => serializeWrite(async () => {
  const serialized = await AsyncStorage.getItem(PHOTO_INDEX_KEY);
  const ids = serialized ? JSON.parse(serialized) as string[] : [];
  await AsyncStorage.multiSet([
    [photoKey(photo.id), JSON.stringify(photo)],
    [PHOTO_INDEX_KEY, JSON.stringify([photo.id, ...ids.filter((id) => id !== photo.id)])],
  ]);
});

export const ingestPhoto = async (input: IngestPhotoInput): Promise<PhotoRecord> => {
  ensureDirectories();
  const id = randomUUID();
  const versionId = randomUUID();
  const mimeType = input.mimeType ?? 'image/jpeg';
  const extension = extensionFor(input.name, mimeType);
  const original = new File(originalsDirectory, `${id}.${extension}`);
  const proxy = new File(proxiesDirectory, `${id}.jpg`);
  const thumbnail = new File(thumbnailsDirectory, `${id}.jpg`);

  await new File(input.uri).copy(original);
  let exif = input.exif ?? {};
  if (Object.keys(exif).length === 0) {
    try {
      exif = (await readExif(await original.arrayBuffer())) as Record<string, unknown> ?? {};
    } catch {
      exif = {};
    }
  }
  await Promise.all([
    createDerivedImage(original.uri, proxy, 1600, 0.82),
    createDerivedImage(original.uri, thumbnail, 320, 0.72),
  ]);

  const createdAt = new Date().toISOString();
  const photo: PhotoRecord = {
    id,
    createdAt,
    captureSource: input.source,
    originalUri: original.uri,
    originalName: input.name,
    originalMimeType: mimeType,
    originalByteSize: original.size,
    originalChecksum: original.md5 ?? `${original.size}:${createdAt}`,
    analysisProxyUri: proxy.uri,
    thumbnailUri: thumbnail.uri,
    width: input.width,
    height: input.height,
    exif,
    currentVersionId: versionId,
    versions: [
      {
        id: versionId,
        photoId: id,
        createdAt,
        label: 'Original',
        stack: emptyLayerStack(),
      },
    ],
    syncState: 'queued',
  };

  await prependPhoto(photo);
  return photo;
};

const PRIVATE_EXIF_KEYS = /gps|latitude|longitude|location/i;

export const exifForRemoteAnalysis = (exif: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(exif).filter(([key]) => !PRIVATE_EXIF_KEYS.test(key)));

const decodeBase64 = (encoded: string) => {
  const binary = globalThis.atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

export const saveGeneratedLayerAsset = (id: string, encoded: string) => {
  ensureDirectories();
  const asset = new File(layerAssetsDirectory, `${id}.png`);
  asset.write(decodeBase64(encoded));
  return asset.uri;
};

export const deleteGeneratedLayerAsset = (id: string) => {
  const asset = new File(layerAssetsDirectory, `${id}.png`);
  if (asset.exists) asset.delete();
};

export const saveImportedLayerAsset = async (id: string, sourceUri: string, mimeType = 'image/jpeg') => {
  ensureDirectories();
  const extension = mimeType === 'image/png' ? 'png' : 'jpg';
  const asset = new File(layerAssetsDirectory, `${id}.${extension}`);
  await new File(sourceUri).copy(asset);
  return asset.uri;
};
