import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { User } from 'react-native-auth0';

import {
  authConfigured,
  getAuthSnapshot,
  initializeAuth,
  signIn as signInWithAuth0,
  signOut as signOutWithAuth0,
  subscribeToAuth,
} from '../services/auth';

type AuthState = {
  configured: boolean;
  error?: string;
  loading: boolean;
  signIn: () => Promise<User>;
  signOut: () => Promise<void>;
  user: User | null;
};

const AuthContext = createContext<AuthState | null>(null);

export const AuthProvider = ({ children }: React.PropsWithChildren) => {
  const initial = getAuthSnapshot();
  const [user, setUser] = useState<User | null>(initial.user);
  const [loading, setLoading] = useState(!initial.initialized);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const unsubscribe = subscribeToAuth((next) => {
      setUser(next.user);
      setLoading(!next.initialized);
      setError(undefined);
    });
    void initializeAuth().catch((caught: unknown) => {
      setLoading(false);
      setError(caught instanceof Error ? caught.message : 'Authentication could not be restored.');
    });
    return unsubscribe;
  }, []);

  const signIn = useCallback(async () => {
    setError(undefined);
    try {
      return await signInWithAuth0();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Sign-in failed.';
      setError(message);
      throw caught;
    }
  }, []);

  const signOut = useCallback(async () => {
    setError(undefined);
    try {
      await signOutWithAuth0();
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Sign-out failed.';
      setError(message);
      throw caught;
    }
  }, []);

  const value = useMemo<AuthState>(() => ({
    configured: authConfigured,
    error,
    loading,
    signIn,
    signOut,
    user,
  }), [error, loading, signIn, signOut, user]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuthSession = () => {
  const state = useContext(AuthContext);
  if (!state) throw new Error('useAuthSession must be used within AuthProvider');
  return state;
};
