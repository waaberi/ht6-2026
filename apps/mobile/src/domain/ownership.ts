export const GUEST_OWNER_ID = 'guest';

export type OwnerId = string;

export const normalizeOwnerId = (ownerId: string | null | undefined): OwnerId => {
  const normalized = ownerId?.trim();
  return normalized || GUEST_OWNER_ID;
};

export const ownerStorageSegment = (ownerId: OwnerId) =>
  encodeURIComponent(normalizeOwnerId(ownerId));

export const ownerDirectorySegment = (ownerId: OwnerId) =>
  normalizeOwnerId(ownerId).replace(/[^a-zA-Z0-9._-]/g, '_');

export const assertOwnerMatches = (actualOwnerId: OwnerId, expectedOwnerId: OwnerId) => {
  if (normalizeOwnerId(actualOwnerId) !== normalizeOwnerId(expectedOwnerId)) {
    throw new Error('This item belongs to a different account.');
  }
};

export const assertAuthenticatedOwner = (
  expectedOwnerId: OwnerId,
  sessionUserId: string | null | undefined,
) => {
  const ownerId = normalizeOwnerId(expectedOwnerId);
  if (ownerId === GUEST_OWNER_ID || sessionUserId !== ownerId) {
    throw new Error('The active account does not own this data.');
  }
  return ownerId;
};
