import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { emptyLayerStack } from '../domain/layers';
import type { PhotoRecord } from '../domain/types';

const PHOTO_INDEX_KEY = 'exposure.photos.v1';
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
  const serialized = await AsyncStorage.getItem(PHOTO_INDEX_KEY);
  if (!serialized) return [];
  try {
    return JSON.parse(serialized) as PhotoRecord[];
  } catch {
    return [];
  }
};

export const savePhotos = async (photos: PhotoRecord[]) => {
  await AsyncStorage.setItem(PHOTO_INDEX_KEY, JSON.stringify(photos));
};

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

  const photos = await listPhotos();
  await savePhotos([photo, ...photos]);
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

export const saveImportedLayerAsset = async (id: string, sourceUri: string, mimeType = 'image/jpeg') => {
  ensureDirectories();
  const extension = mimeType === 'image/png' ? 'png' : 'jpg';
  const asset = new File(layerAssetsDirectory, `${id}.${extension}`);
  await new File(sourceUri).copy(asset);
  return asset.uri;
};
