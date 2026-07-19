import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { layerAssetsForStacks } from '../domain/assets';
import { emptyLayerStack } from '../domain/layers';
import {
  claimGuestPhotos,
  claimableGuestPhotos,
  mergeOfflinePhotos,
  type GuestPhotoClaims,
} from '../domain/offlineMerge';
import {
  GUEST_OWNER_ID,
  assertOwnerMatches,
  ownerDirectorySegment,
  ownerStorageSegment,
  type OwnerId,
} from '../domain/ownership';
import type { Layer, PhotoRecord } from '../domain/types';
import { getActiveOwnerId } from './ownerScope';

const PHOTO_INDEX_KEY = 'exposure.photos.index.v2';
const PHOTO_DELETIONS_KEY = 'exposure.photos.deletions.v1';
const LEGACY_PHOTOS_KEY = 'exposure.photos.v1';
const GUEST_PHOTO_CLAIMS_KEY = 'exposure.guest.photo-claims.v1';
const legacyPhotoKey = (id: string) => `exposure.photo.v2.${id}`;
const ownerKeys = (ownerId: OwnerId) => {
  const owner = ownerStorageSegment(ownerId);
  return {
    index: `exposure.owner.${owner}.photos.index.v3`,
    deletions: `exposure.owner.${owner}.photos.deletions.v2`,
    photo: (id: string) => `exposure.owner.${owner}.photo.v3.${id}`,
  };
};
let persistenceQueue = Promise.resolve();

const serializeWrite = <T,>(work: () => Promise<T>) => {
  const pending = persistenceQueue.then(work, work);
  persistenceQueue = pending.then(() => undefined, () => undefined);
  return pending;
};
const exposureDirectory = new Directory(Paths.document, 'exposure');
const directoriesForOwner = (ownerId: OwnerId) => {
  const ownerDirectory = new Directory(exposureDirectory, 'owners', ownerDirectorySegment(ownerId));
  return {
    ownerDirectory,
    originalsDirectory: new Directory(ownerDirectory, 'originals'),
    proxiesDirectory: new Directory(ownerDirectory, 'proxies'),
    thumbnailsDirectory: new Directory(ownerDirectory, 'thumbnails'),
    layerAssetsDirectory: new Directory(ownerDirectory, 'layer-assets'),
  };
};

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

const ensureDirectories = (ownerId: OwnerId) => {
  const directories = directoriesForOwner(ownerId);
  exposureDirectory.create({ intermediates: true, idempotent: true });
  directories.ownerDirectory.create({ intermediates: true, idempotent: true });
  directories.originalsDirectory.create({ intermediates: true, idempotent: true });
  directories.proxiesDirectory.create({ intermediates: true, idempotent: true });
  directories.thumbnailsDirectory.create({ intermediates: true, idempotent: true });
  directories.layerAssetsDirectory.create({ intermediates: true, idempotent: true });
  return directories;
};

const copyPrivateFile = async (sourceUri: string, destination: File) => {
  if (destination.exists) return destination.uri;
  const source = new File(sourceUri);
  if (!source.exists) throw new Error(`A local photo file is missing: ${sourceUri}`);
  await source.copy(destination);
  return destination.uri;
};

const withCopiedAssetUris = (layer: Layer, assetUris: Map<string, string>): Layer => {
  if (layer.type === 'image') {
    return { ...layer, uri: assetUris.get(layer.assetId) ?? layer.uri };
  }
  if (layer.type === 'retouch' || layer.type === 'generative-patch') {
    return {
      ...layer,
      patchUri: assetUris.get(layer.patchAssetId) ?? layer.patchUri,
      maskUri: assetUris.get(layer.maskAssetId) ?? layer.maskUri,
    };
  }
  if (layer.type === 'masked-adjustment' && layer.mask.assetId) {
    return { ...layer, mask: { ...layer.mask, uri: assetUris.get(layer.mask.assetId) ?? layer.mask.uri } };
  }
  return layer;
};

const copyGuestPhotoToOwner = async (photo: PhotoRecord, ownerId: OwnerId): Promise<PhotoRecord> => {
  assertOwnerMatches(photo.ownerId, GUEST_OWNER_ID);
  const { originalsDirectory, proxiesDirectory, thumbnailsDirectory, layerAssetsDirectory } = ensureDirectories(ownerId);
  const original = new File(originalsDirectory, `${photo.id}.${extensionFor(photo.originalName, photo.originalMimeType)}`);
  const proxy = new File(proxiesDirectory, `${photo.id}.jpg`);
  const thumbnail = new File(thumbnailsDirectory, `${photo.id}.jpg`);
  const [originalUri, analysisProxyUri, thumbnailUri] = await Promise.all([
    copyPrivateFile(photo.originalUri, original),
    copyPrivateFile(photo.analysisProxyUri, proxy),
    copyPrivateFile(photo.thumbnailUri, thumbnail),
  ]);

  const assetUris = new Map<string, string>();
  for (const asset of layerAssetsForStacks(photo.versions.map((version) => version.stack))) {
    const destination = new File(layerAssetsDirectory, `${asset.id}.${asset.mimeType === 'image/png' ? 'png' : 'jpg'}`);
    assetUris.set(asset.id, await copyPrivateFile(asset.uri, destination));
  }

  return {
    ...photo,
    ownerId,
    originalUri,
    remoteOriginalPath: undefined,
    analysisProxyUri,
    thumbnailUri,
    versions: photo.versions.map((version) => ({
      ...version,
      stack: {
        ...version.stack,
        layers: version.stack.layers.map((layer) => withCopiedAssetUris(layer, assetUris)),
      },
    })),
    syncState: 'queued',
  };
};

const readGuestPhotoClaims = async (): Promise<GuestPhotoClaims> => {
  const serialized = await AsyncStorage.getItem(GUEST_PHOTO_CLAIMS_KEY);
  if (!serialized) return {};
  try {
    const parsed = JSON.parse(serialized) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
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

export const listPhotos = async (ownerId: OwnerId = getActiveOwnerId()): Promise<PhotoRecord[]> => {
  const keys = ownerKeys(ownerId);
  let serialized = await AsyncStorage.getItem(keys.index);
  if (!serialized && ownerId === GUEST_OWNER_ID) {
    const legacyIndex = await AsyncStorage.getItem(PHOTO_INDEX_KEY);
    try {
      const photos = legacyIndex
        ? (await AsyncStorage.multiGet((JSON.parse(legacyIndex) as string[]).map(legacyPhotoKey)))
          .flatMap(([, value]) => value ? [JSON.parse(value) as PhotoRecord] : [])
        : JSON.parse((await AsyncStorage.getItem(LEGACY_PHOTOS_KEY)) ?? '[]') as PhotoRecord[];
      const migrated = photos.map((photo) => ({ ...photo, ownerId: GUEST_OWNER_ID }));
      await savePhotos(migrated, ownerId);
      serialized = JSON.stringify(migrated.map((photo) => photo.id));
      if (migrated.length === 0) await AsyncStorage.setItem(keys.index, '[]');
    } catch {
      await AsyncStorage.setItem(keys.index, '[]');
      return [];
    }
  }
  if (!serialized) {
    await AsyncStorage.setItem(keys.index, '[]');
    return [];
  }
  try {
    const ids = JSON.parse(serialized) as string[];
    const rows = await AsyncStorage.multiGet(ids.map(keys.photo));
    return rows.flatMap(([, value]) => {
      if (!value) return [];
      try {
        const photo = JSON.parse(value) as PhotoRecord;
        return photo.ownerId === ownerId ? [photo] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
};

export const savePhotos = (photos: PhotoRecord[], ownerId: OwnerId = getActiveOwnerId()) => serializeWrite(async () => {
  photos.forEach((photo) => assertOwnerMatches(photo.ownerId, ownerId));
  const keys = ownerKeys(ownerId);
  await AsyncStorage.multiSet([
    [keys.index, JSON.stringify(photos.map((photo) => photo.id))],
    ...photos.map((photo) => [keys.photo(photo.id), JSON.stringify(photo)] as [string, string]),
  ]);
});

export const savePhoto = (photo: PhotoRecord, ownerId: OwnerId = photo.ownerId) => serializeWrite(async () => {
  assertOwnerMatches(photo.ownerId, ownerId);
  await AsyncStorage.setItem(ownerKeys(ownerId).photo(photo.id), JSON.stringify(photo));
});

export const migrateGuestPhotosToOwner = async (ownerId: OwnerId): Promise<PhotoRecord[]> => {
  if (ownerId === GUEST_OWNER_ID) return listPhotos(GUEST_OWNER_ID);
  const [guestPhotos, accountPhotos, deletedPhotoIds, claims] = await Promise.all([
    listPhotos(GUEST_OWNER_ID),
    listPhotos(ownerId),
    listPhotoDeletionIds(ownerId),
    readGuestPhotoClaims(),
  ]);
  const claimable = claimableGuestPhotos(
    guestPhotos,
    claims,
    ownerId,
    deletedPhotoIds,
    accountPhotos.map((photo) => photo.id),
  );
  if (claimable.length === 0) return accountPhotos;

  const offlineCopies: PhotoRecord[] = [];
  for (const photo of claimable) offlineCopies.push(await copyGuestPhotoToOwner(photo, ownerId));
  const merged = mergeOfflinePhotos(ownerId, accountPhotos, offlineCopies);
  await savePhotos(merged, ownerId);
  await AsyncStorage.setItem(
    GUEST_PHOTO_CLAIMS_KEY,
    JSON.stringify(claimGuestPhotos(claims, claimable.map((photo) => photo.id), ownerId)),
  );
  return merged;
};

export const listPhotoDeletionIds = async (ownerId: OwnerId = getActiveOwnerId()): Promise<string[]> => {
  const keys = ownerKeys(ownerId);
  const serialized = await AsyncStorage.getItem(keys.deletions);
  if (!serialized && ownerId === GUEST_OWNER_ID) {
    const legacy = await AsyncStorage.getItem(PHOTO_DELETIONS_KEY);
    if (!legacy) return [];
    try {
      const ids = JSON.parse(legacy) as string[];
      await AsyncStorage.setItem(keys.deletions, JSON.stringify(ids));
      return ids;
    } catch {
      return [];
    }
  }
  if (!serialized) return [];
  try {
    return JSON.parse(serialized) as string[];
  } catch {
    return [];
  }
};

export const clearPhotoDeletionId = (photoId: string, ownerId: OwnerId = getActiveOwnerId()) => serializeWrite(async () => {
  const keys = ownerKeys(ownerId);
  const ids = await listPhotoDeletionIds(ownerId);
  await AsyncStorage.setItem(keys.deletions, JSON.stringify(ids.filter((id) => id !== photoId)));
});

const deleteLocalFile = (uri: string | undefined) => {
  if (!uri?.startsWith('file:')) return;
  const file = new File(uri);
  if (file.exists) file.delete();
};

export const deletePhoto = (photo: PhotoRecord, ownerId: OwnerId = photo.ownerId) => serializeWrite(async () => {
  assertOwnerMatches(photo.ownerId, ownerId);
  const keys = ownerKeys(ownerId);
  const [serializedIndex, deletedIds] = await Promise.all([
    AsyncStorage.getItem(keys.index),
    listPhotoDeletionIds(ownerId),
  ]);
  const ids = serializedIndex ? JSON.parse(serializedIndex) as string[] : [];
  await AsyncStorage.multiSet([
    [keys.index, JSON.stringify(ids.filter((id) => id !== photo.id))],
    [keys.deletions, JSON.stringify([...new Set([...deletedIds, photo.id])])],
  ]);
  await AsyncStorage.removeItem(keys.photo(photo.id));

  deleteLocalFile(photo.originalUri);
  deleteLocalFile(photo.analysisProxyUri);
  deleteLocalFile(photo.thumbnailUri);
  const assets = layerAssetsForStacks(photo.versions.map((version) => version.stack));
  for (const asset of assets) deleteLocalFile(asset.uri);
});

const prependPhoto = (photo: PhotoRecord) => serializeWrite(async () => {
  const keys = ownerKeys(photo.ownerId);
  const serialized = await AsyncStorage.getItem(keys.index);
  const ids = serialized ? JSON.parse(serialized) as string[] : [];
  await AsyncStorage.multiSet([
    [keys.photo(photo.id), JSON.stringify(photo)],
    [keys.index, JSON.stringify([photo.id, ...ids.filter((id) => id !== photo.id)])],
  ]);
});

export const ingestPhoto = async (
  input: IngestPhotoInput,
  ownerId: OwnerId = getActiveOwnerId(),
): Promise<PhotoRecord> => {
  const { originalsDirectory, proxiesDirectory, thumbnailsDirectory } = ensureDirectories(ownerId);
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
    ownerId,
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
  const { layerAssetsDirectory } = ensureDirectories(getActiveOwnerId());
  const asset = new File(layerAssetsDirectory, `${id}.png`);
  asset.write(decodeBase64(encoded));
  return asset.uri;
};

export const deleteGeneratedLayerAsset = (id: string) => {
  const { layerAssetsDirectory } = directoriesForOwner(getActiveOwnerId());
  const asset = new File(layerAssetsDirectory, `${id}.png`);
  if (asset.exists) asset.delete();
};

export const saveImportedLayerAsset = async (id: string, sourceUri: string, mimeType = 'image/jpeg') => {
  const { layerAssetsDirectory } = ensureDirectories(getActiveOwnerId());
  const extension = mimeType === 'image/png' ? 'png' : 'jpg';
  const asset = new File(layerAssetsDirectory, `${id}.${extension}`);
  await new File(sourceUri).copy(asset);
  return asset.uri;
};
