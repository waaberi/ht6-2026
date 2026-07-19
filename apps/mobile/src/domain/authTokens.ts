import { jwtDecode } from 'jwt-decode';

import type { Credentials, User } from 'react-native-auth0';

export type OAuthTokenResponse = {
  accessToken: string;
  expiresIn?: number;
  idToken?: string;
  issuedAt?: number;
  refreshToken?: string;
  scope?: string;
  tokenType?: string;
};

const stringClaim = (value: unknown) => typeof value === 'string' ? value : undefined;
const booleanClaim = (value: unknown) => typeof value === 'boolean' ? value : undefined;

export const decodeAuth0User = (idToken: string): User => {
  const claims = jwtDecode<Record<string, unknown>>(idToken);
  const sub = stringClaim(claims.sub);
  if (!sub) throw new Error('ID token is missing the required "sub" claim.');

  return {
    ...claims,
    sub,
    name: stringClaim(claims.name),
    givenName: stringClaim(claims.given_name),
    familyName: stringClaim(claims.family_name),
    middleName: stringClaim(claims.middle_name),
    nickname: stringClaim(claims.nickname),
    preferredUsername: stringClaim(claims.preferred_username),
    profile: stringClaim(claims.profile),
    picture: stringClaim(claims.picture),
    website: stringClaim(claims.website),
    email: stringClaim(claims.email),
    emailVerified: booleanClaim(claims.email_verified),
    gender: stringClaim(claims.gender),
    birthdate: stringClaim(claims.birthdate),
    zoneinfo: stringClaim(claims.zoneinfo),
    locale: stringClaim(claims.locale),
    phoneNumber: stringClaim(claims.phone_number),
    phoneNumberVerified: booleanClaim(claims.phone_number_verified),
    address: stringClaim(claims.address),
    updatedAt: stringClaim(claims.updated_at),
  };
};

export const credentialsFromTokenResponse = (
  response: OAuthTokenResponse,
  previous?: Credentials,
): Credentials => {
  const idToken = response.idToken ?? previous?.idToken;
  if (!response.accessToken || !idToken) {
    throw new Error('Auth0 did not return the required access and ID tokens.');
  }

  const issuedAt = response.issuedAt ?? Math.floor(Date.now() / 1000);
  return {
    accessToken: response.accessToken,
    expiresAt: issuedAt + (response.expiresIn ?? 3600),
    idToken,
    refreshToken: response.refreshToken ?? previous?.refreshToken,
    scope: response.scope ?? previous?.scope,
    tokenType: response.tokenType ?? previous?.tokenType ?? 'Bearer',
  };
};

export const credentialsExpireSoon = (
  credentials: Credentials,
  now = Math.floor(Date.now() / 1000),
  leewaySeconds = 60,
) => credentials.expiresAt <= now + leewaySeconds;

export const isCredentials = (value: unknown): value is Credentials => {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Credentials>;
  return typeof candidate.accessToken === 'string'
    && typeof candidate.idToken === 'string'
    && typeof candidate.tokenType === 'string'
    && typeof candidate.expiresAt === 'number'
    && Number.isFinite(candidate.expiresAt);
};
