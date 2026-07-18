import { Linking } from 'react-native';

import { supabase } from './supabase';

export const AUTH_REDIRECT_URL = 'exposure://auth/callback';
const handledAuthUrls = new Set<string>();

const paramsFromUrl = (url: string) => {
  const query = url.includes('?') ? url.split('?')[1]?.split('#')[0] : '';
  const fragment = url.includes('#') ? url.split('#')[1] : '';
  const entries = [query, fragment]
    .filter(Boolean)
    .flatMap((part) => part.split('&'))
    .map((entry) => {
      const separator = entry.indexOf('=');
      const key = separator >= 0 ? entry.slice(0, separator) : entry;
      const value = separator >= 0 ? entry.slice(separator + 1) : '';
      return [
        decodeURIComponent(key.replace(/\+/g, ' ')),
        decodeURIComponent(value.replace(/\+/g, ' ')),
      ] as [string, string];
    });
  return Object.fromEntries(entries);
};

export const sendMagicLink = async (email: string) => {
  if (!supabase) throw new Error('Cloud sync is not configured.');
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail || !normalizedEmail.includes('@')) throw new Error('Enter a valid email address.');

  const { error } = await supabase.auth.signInWithOtp({
    email: normalizedEmail,
    options: { emailRedirectTo: AUTH_REDIRECT_URL },
  });
  if (error) throw error;
};

export const completeAuthFromUrl = async (url: string) => {
  if (!supabase || !url.startsWith(AUTH_REDIRECT_URL)) return false;
  const params = paramsFromUrl(url);

  if (params.error_description || params.error) {
    throw new Error(params.error_description || params.error);
  }
  if (params.code) {
    const { error } = await supabase.auth.exchangeCodeForSession(params.code);
    if (error) throw error;
    return true;
  }
  if (params.access_token && params.refresh_token) {
    const { error } = await supabase.auth.setSession({
      access_token: params.access_token,
      refresh_token: params.refresh_token,
    });
    if (error) throw error;
    return true;
  }
  return false;
};

export const listenForAuthLinks = (onError?: (error: Error) => void) => {
  const handle = (url: string | null) => {
    if (!url || !url.startsWith(AUTH_REDIRECT_URL) || handledAuthUrls.has(url)) return;
    handledAuthUrls.add(url);
    void completeAuthFromUrl(url).catch((caught: unknown) => {
      handledAuthUrls.delete(url);
      onError?.(caught instanceof Error ? caught : new Error('Sign-in failed.'));
    });
  };

  void Linking.getInitialURL().then(handle);
  const subscription = Linking.addEventListener('url', ({ url }) => handle(url));
  return () => subscription.remove();
};

export const signOut = async () => {
  if (!supabase) return;
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
};
