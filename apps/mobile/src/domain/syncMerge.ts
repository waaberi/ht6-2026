import type { PhotoRecord } from './types';

const hasDifferentHistory = (local: PhotoRecord, remote: PhotoRecord) =>
  local.currentVersionId !== remote.currentVersionId
  || local.versions.some((version) => !remote.versions.some((candidate) => candidate.id === version.id));

export const mergeSyncProgress = (current: PhotoRecord[], progress: PhotoRecord[]) => {
  const progressById = new Map(progress.map((photo) => [photo.id, photo]));
  return current.map((photo) => {
    const synced = progressById.get(photo.id);
    return synced && !hasDifferentHistory(photo, synced) ? synced : photo;
  });
};

export const mergeHydratedPhotos = (
  current: PhotoRecord[],
  hydrated: PhotoRecord[],
  deletedPhotoIds: Iterable<string>,
) => {
  const deleted = new Set(deletedPhotoIds);
  const localById = new Map(current.map((photo) => [photo.id, photo]));
  const merged = hydrated.filter((photo) => !deleted.has(photo.id)).map((remote) => {
    const local = localById.get(remote.id);
    localById.delete(remote.id);
    if (!local) return remote;
    return local.syncState !== 'synced' || hasDifferentHistory(local, remote) ? local : remote;
  });
  return [...merged, ...localById.values()]
    .filter((photo) => !deleted.has(photo.id))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
};
