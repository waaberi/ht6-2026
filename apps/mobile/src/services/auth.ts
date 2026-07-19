import Constants from 'expo-constants';
import * as AuthSession from 'expo-auth-session';
import * as SecureStore from 'expo-secure-store';
import * as WebBrowser from 'expo-web-browser';
import type { Credentials, User } from 'react-native-auth0';

import {
  credentialsExpireSoon,
  credentialsFromTokenResponse,
  decodeAuth0User,
  isCredentials,
} from '../domain/authTokens';

WebBrowser.maybeCompleteAuthSession();

export const AUTH0_DOMAIN = process.env.EXPO_PUBLIC_AUTH0_DOMAIN?.trim()
  || 'dev-40ogr4b5dnzkfkp3.us.auth0.com';
export const AUTH0_CLIENT_ID = process.env.EXPO_PUBLIC_AUTH0_CLIENT_ID?.trim()
  || 'L5zovg4M47k5RajkppMMtIT4oBwcWYhq';
export const AUTH0_AUDIENCE = process.env.EXPO_PUBLIC_AUTH0_AUDIENCE?.trim()
  || 'https://api.exposure.app';
export const AUTH0_CUSTOM_SCHEME = 'exposure';

export const runningInExpoGo = Constants.expoGoConfig !== null;
export const authConfigured = Boolean(
  AUTH0_DOMAIN
  && AUTH0_CLIENT_ID
  && AUTH0_AUDIENCE
);

const AUTH0_ISSUER = `https://${AUTH0_DOMAIN}`;
const AUTH0_SCOPES = ['openid', 'profile', 'email', 'offline_access'];
const EXPO_GO_AUTH_PATH = 'auth/callback';
const EXPO_GO_CREDENTIALS_KEY = 'exposure.auth0.expo-go.credentials.v1';

export const AUTH0_EXPO_GO_REDIRECT_URI = AuthSession.makeRedirectUri({
  native: `${AUTH0_CUSTOM_SCHEME}://${EXPO_GO_AUTH_PATH}`,
  path: EXPO_GO_AUTH_PATH,
  scheme: AUTH0_CUSTOM_SCHEME,
});

const authDiscovery = {
  authorizationEndpoint: `${AUTH0_ISSUER}/authorize`,
  endSessionEndpoint: `${AUTH0_ISSUER}/v2/logout`,
  revocationEndpoint: `${AUTH0_ISSUER}/oauth/revoke`,
  tokenEndpoint: `${AUTH0_ISSUER}/oauth/token`,
};

type Auth0Constructor = typeof import('react-native-auth0').default;
type Auth0Client = InstanceType<Auth0Constructor>;
let auth0Promise: Promise<Auth0Client | null> | undefined;

const getAuth0Client = () => {
  if (!authConfigured || runningInExpoGo) return Promise.resolve(null);
  auth0Promise ??= import('react-native-auth0').then(({ default: Auth0 }) => new Auth0({
    domain: AUTH0_DOMAIN,
    clientId: AUTH0_CLIENT_ID,
    // The Exposure API currently uses standard Bearer tokens. DPoP can be
    // enabled later when every request also sends a per-request proof.
    useDPoP: false,
  }));
  return auth0Promise;
};

type AuthSnapshot = {
  initialized: boolean;
  user: User | null;
};

let snapshot: AuthSnapshot = { initialized: false, user: null };
const listeners = new Set<(next: AuthSnapshot) => void>();

const publish = (next: AuthSnapshot) => {
  snapshot = next;
  listeners.forEach((listener) => listener(snapshot));
};

const isMissingCredentials = (error: unknown) =>
  typeof error === 'object'
  && error !== null
  && 'type' in error
  && error.type === 'NO_CREDENTIALS';

const clearExpoGoCredentials = () => SecureStore.deleteItemAsync(EXPO_GO_CREDENTIALS_KEY);

const saveExpoGoCredentials = (credentials: Credentials) =>
  SecureStore.setItemAsync(EXPO_GO_CREDENTIALS_KEY, JSON.stringify(credentials));

const readExpoGoCredentials = async () => {
  const serialized = await SecureStore.getItemAsync(EXPO_GO_CREDENTIALS_KEY);
  if (!serialized) return null;
  try {
    const credentials: unknown = JSON.parse(serialized);
    if (isCredentials(credentials)) return credentials;
  } catch {
    // Invalid or obsolete sessions are cleared below.
  }
  await clearExpoGoCredentials();
  return null;
};

let expoGoCredentialsPromise: Promise<Credentials | null> | undefined;

const getExpoGoCredentials = () => {
  expoGoCredentialsPromise ??= (async () => {
    const credentials = await readExpoGoCredentials();
    if (!credentials || !credentialsExpireSoon(credentials)) return credentials;
    if (!credentials.refreshToken) {
      await clearExpoGoCredentials();
      return null;
    }

    const response = await AuthSession.refreshAsync({
      clientId: AUTH0_CLIENT_ID,
      refreshToken: credentials.refreshToken,
    }, authDiscovery);
    const refreshed = credentialsFromTokenResponse(response, credentials);
    await saveExpoGoCredentials(refreshed);
    return refreshed;
  })().finally(() => {
    expoGoCredentialsPromise = undefined;
  });
  return expoGoCredentialsPromise;
};

export const getAuthSnapshot = () => snapshot;

export const subscribeToAuth = (listener: (next: AuthSnapshot) => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const getCurrentAuthUser = () => snapshot.user;

export const getAuth0Credentials = async (): Promise<Credentials | null> => {
  if (runningInExpoGo) return getExpoGoCredentials();
  const auth0 = await getAuth0Client();
  if (!auth0) return null;
  try {
    return await auth0.credentialsManager.getCredentials();
  } catch (error) {
    if (isMissingCredentials(error)) return null;
    throw error;
  }
};

export const initializeAuth = async () => {
  const credentials = await getAuth0Credentials();
  const user = credentials ? decodeAuth0User(credentials.idToken) : null;
  publish({ initialized: true, user });
  return user;
};

export const signIn = async () => {
  if (!authConfigured) throw new Error('Auth0 is not configured.');
  if (runningInExpoGo) {
    const request = new AuthSession.AuthRequest({
      clientId: AUTH0_CLIENT_ID,
      extraParams: { audience: AUTH0_AUDIENCE },
      redirectUri: AUTH0_EXPO_GO_REDIRECT_URI,
      responseType: AuthSession.ResponseType.Code,
      scopes: AUTH0_SCOPES,
      usePKCE: true,
    });
    const result = await request.promptAsync(authDiscovery);
    if (result.type !== 'success') {
      if (result.type === 'error') {
        throw new Error(result.error?.message ?? result.params.error_description ?? 'Auth0 sign-in failed.');
      }
      throw new Error(result.type === 'locked' ? 'Another sign-in is already in progress.' : 'Sign-in was cancelled.');
    }
    const code = result.params.code;
    if (!code || !request.codeVerifier) throw new Error('Auth0 did not return a valid authorization code.');

    const response = await AuthSession.exchangeCodeAsync({
      clientId: AUTH0_CLIENT_ID,
      code,
      extraParams: { code_verifier: request.codeVerifier },
      redirectUri: AUTH0_EXPO_GO_REDIRECT_URI,
    }, authDiscovery);
    const credentials = credentialsFromTokenResponse(response);
    await saveExpoGoCredentials(credentials);
    const user = decodeAuth0User(credentials.idToken);
    publish({ initialized: true, user });
    return user;
  }

  const auth0 = await getAuth0Client();
  if (!auth0) throw new Error('Auth0 is not available in this build.');
  const credentials = await auth0.webAuth.authorize(
    {
      audience: AUTH0_AUDIENCE,
      scope: 'openid profile email offline_access',
    },
    { customScheme: AUTH0_CUSTOM_SCHEME },
  );
  await auth0.credentialsManager.saveCredentials(credentials);
  const user = decodeAuth0User(credentials.idToken);
  publish({ initialized: true, user });
  return user;
};

export const signOut = async () => {
  if (runningInExpoGo) {
    await clearExpoGoCredentials();
    publish({ initialized: true, user: null });
    const query = new URLSearchParams({
      client_id: AUTH0_CLIENT_ID,
      returnTo: AUTH0_EXPO_GO_REDIRECT_URI,
    });
    await WebBrowser.openAuthSessionAsync(
      `${authDiscovery.endSessionEndpoint}?${query}`,
      AUTH0_EXPO_GO_REDIRECT_URI,
    );
    return;
  }

  const auth0 = await getAuth0Client();
  if (!auth0) {
    publish({ initialized: true, user: null });
    return;
  }
  await auth0.webAuth.clearSession({}, { customScheme: AUTH0_CUSTOM_SCHEME });
  await auth0.credentialsManager.clearCredentials();
  publish({ initialized: true, user: null });
};

export const getAuth0AccessToken = async () =>
  (await getAuth0Credentials())?.accessToken ?? null;

export const getAuth0IdToken = async () =>
  (await getAuth0Credentials())?.idToken ?? null;
