import { GUEST_OWNER_ID, normalizeOwnerId, type OwnerId } from '../domain/ownership';

let activeOwnerId: OwnerId = GUEST_OWNER_ID;

export const getActiveOwnerId = () => activeOwnerId;

export const setActiveOwnerId = (ownerId: string | null | undefined) => {
  activeOwnerId = normalizeOwnerId(ownerId);
  return activeOwnerId;
};
