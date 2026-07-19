import assert from 'node:assert/strict';
import test from 'node:test';

import {
  credentialsExpireSoon,
  credentialsFromTokenResponse,
  decodeAuth0User,
  isCredentials,
} from './authTokens';

const idToken = [
  Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url'),
  Buffer.from(JSON.stringify({
    sub: 'auth0|hackathon-user',
    email: 'photographer@example.com',
    email_verified: true,
    given_name: 'Exposure',
    'https://example.test/role': 'authenticated',
  })).toString('base64url'),
  '',
].join('.');

test('normalizes standard Auth0 profile claims without losing custom claims', () => {
  const user = decodeAuth0User(idToken);
  assert.equal(user.sub, 'auth0|hackathon-user');
  assert.equal(user.emailVerified, true);
  assert.equal(user.givenName, 'Exposure');
  assert.equal(user['https://example.test/role'], 'authenticated');
});

test('converts an Expo token response to the credentials contract used by the app', () => {
  const credentials = credentialsFromTokenResponse({
    accessToken: 'access-token',
    expiresIn: 3600,
    idToken,
    issuedAt: 1_000,
    refreshToken: 'refresh-token',
    scope: 'openid profile email offline_access',
    tokenType: 'bearer',
  });

  assert.deepEqual(credentials, {
    accessToken: 'access-token',
    expiresAt: 4_600,
    idToken,
    refreshToken: 'refresh-token',
    scope: 'openid profile email offline_access',
    tokenType: 'bearer',
  });
  assert.equal(isCredentials(credentials), true);
  assert.equal(credentialsExpireSoon(credentials, 4_539), false);
  assert.equal(credentialsExpireSoon(credentials, 4_540), true);
});

test('refresh responses retain the prior ID and refresh tokens when Auth0 rotates neither', () => {
  const previous = credentialsFromTokenResponse({
    accessToken: 'old-access-token',
    idToken,
    refreshToken: 'refresh-token',
  });
  const refreshed = credentialsFromTokenResponse({
    accessToken: 'new-access-token',
    expiresIn: 7200,
    issuedAt: 2_000,
  }, previous);

  assert.equal(refreshed.accessToken, 'new-access-token');
  assert.equal(refreshed.idToken, idToken);
  assert.equal(refreshed.refreshToken, 'refresh-token');
  assert.equal(refreshed.expiresAt, 9_200);
});

test('rejects malformed stored sessions and token responses without an ID token', () => {
  assert.equal(isCredentials({ accessToken: 'only-one-token' }), false);
  assert.throws(
    () => credentialsFromTokenResponse({ accessToken: 'access-token' }),
    /required access and ID tokens/,
  );
  assert.throws(() => decodeAuth0User('not-a-jwt'), /Invalid token/);
});
