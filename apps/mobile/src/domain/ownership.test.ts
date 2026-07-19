import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GUEST_OWNER_ID,
  assertAuthenticatedOwner,
  assertOwnerMatches,
  normalizeOwnerId,
  ownerDirectorySegment,
  ownerStorageSegment,
} from './ownership';

test('missing owners are isolated in the explicit guest namespace', () => {
  assert.equal(normalizeOwnerId(undefined), GUEST_OWNER_ID);
  assert.equal(ownerStorageSegment(GUEST_OWNER_ID), 'guest');
});

test('owner identifiers are safe in storage keys and directories', () => {
  assert.equal(ownerStorageSegment('account/user'), 'account%2Fuser');
  assert.equal(ownerDirectorySegment('account/user'), 'account_user');
});

test('cross-owner records fail closed', () => {
  assert.throws(() => assertOwnerMatches('account-a', 'account-b'), /different account/);
  assert.doesNotThrow(() => assertOwnerMatches('account-a', 'account-a'));
});

test('cloud work requires the matching authenticated account and never guest', () => {
  assert.equal(assertAuthenticatedOwner('account-a', 'account-a'), 'account-a');
  assert.throws(() => assertAuthenticatedOwner('account-a', 'account-b'), /does not own/);
  assert.throws(() => assertAuthenticatedOwner(GUEST_OWNER_ID, 'account-a'), /does not own/);
});
