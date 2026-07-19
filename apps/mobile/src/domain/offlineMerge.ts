import type { PhotoRecord, PhotoVersion } from './types';
import {
  GUEST_OWNER_ID,
  assertOwnerMatches,
  type OwnerId,
} from './ownership';

export type GuestPhotoClaims = Record<string, OwnerId>;

const timestamp = (value: string) => {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const currentVersion = (photo: PhotoRecord): PhotoVersion | undefined =>
  photo.versions.find((version) => version.id === photo.currentVersionId);

export const claimableGuestPhotos = (
  guestPhotos: PhotoRecord[],
  claims: GuestPhotoClaims,
  ownerId: OwnerId,
  deletedPhotoIds: Iterable<string> = [],
  accountPhotoIds: Iterable<string> = [],
) => {
  if (ownerId === GUEST_OWNER_ID) throw new Error('Guest content can only be copied into an account.');
  guestPhotos.forEach((photo) => assertOwnerMatches(photo.ownerId, GUEST_OWNER_ID));
  const deleted = new Set(deletedPhotoIds);
  const accountPhotos = new Set(accountPhotoIds);
  return guestPhotos.filter((photo) =>
    !deleted.has(photo.id)
    && (
      !claims[photo.id]
      || (claims[photo.id] === ownerId && accountPhotos.has(photo.id))
    ));
};

export const claimGuestPhotos = (
  claims: GuestPhotoClaims,
  photoIds: Iterable<string>,
  ownerId: OwnerId,
): GuestPhotoClaims => {
  if (ownerId === GUEST_OWNER_ID) throw new Error('Guest content can only be claimed by an account.');
  const next = { ...claims };
  for (const photoId of photoIds) next[photoId] = ownerId;
  return next;
};

const mergePhotoHistory = (account: PhotoRecord, offline: PhotoRecord) => {
  const versions = new Map(account.versions.map((version) => [version.id, version]));
  let addedOfflineHistory = false;
  for (const version of offline.versions) {
    if (!versions.has(version.id)) {
      versions.set(version.id, version);
      addedOfflineHistory = true;
    }
  }

  const accountCurrent = currentVersion(account);
  const offlineCurrent = currentVersion(offline);
  const offlineIsNewer = Boolean(
    offlineCurrent
    && (!accountCurrent || timestamp(offlineCurrent.createdAt) > timestamp(accountCurrent.createdAt)),
  );
  const changed = addedOfflineHistory || offlineIsNewer;
  if (!changed) return account;

  return {
    ...account,
    currentVersionId: offlineIsNewer ? offline.currentVersionId : account.currentVersionId,
    versions: [...versions.values()].sort((left, right) => timestamp(left.createdAt) - timestamp(right.createdAt)),
    syncState: 'queued' as const,
  };
};

export const mergeOfflinePhotos = (
  ownerId: OwnerId,
  accountPhotos: PhotoRecord[],
  offlineCopies: PhotoRecord[],
) => {
  accountPhotos.forEach((photo) => assertOwnerMatches(photo.ownerId, ownerId));
  offlineCopies.forEach((photo) => assertOwnerMatches(photo.ownerId, ownerId));
  const merged = new Map(accountPhotos.map((photo) => [photo.id, photo]));
  for (const offline of offlineCopies) {
    const account = merged.get(offline.id);
    merged.set(offline.id, account ? mergePhotoHistory(account, offline) : offline);
  }
  return [...merged.values()].sort((left, right) => timestamp(right.createdAt) - timestamp(left.createdAt));
};
