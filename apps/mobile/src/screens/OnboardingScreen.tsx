import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors } from '../components/theme';
import { listenForAuthLinks, sendMagicLink } from '../services/auth';
import { supabase } from '../services/supabase';

const ONBOARDING_COMPLETE_KEY = 'exposure.onboarding.complete.v1';

export const hasCompletedOnboarding = async () =>
  (await AsyncStorage.getItem(ONBOARDING_COMPLETE_KEY)) === 'true';

export const completeOnboarding = () =>
  AsyncStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');

export const resetOnboarding = () =>
  AsyncStorage.removeItem(ONBOARDING_COMPLETE_KEY);

export const OnboardingScreen = ({ onComplete }: { onComplete: () => void }) => {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const completedRef = useRef(false);

  const finish = async () => {
    if (completedRef.current) return;
    completedRef.current = true;
    await completeOnboarding();
    onComplete();
  };

  useEffect(() => {
    const stopLinks = listenForAuthLinks((error) => setMessage(error.message));
    void supabase?.auth.getSession().then(({ data }) => {
      if (data.session) void finish();
    });
    const authSubscription = supabase?.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') void finish();
    }).data.subscription;
    return () => {
      stopLinks();
      authSubscription?.unsubscribe();
    };
  }, []);

  const signIn = async () => {
    setBusy(true);
    setMessage(undefined);
    try {
      await sendMagicLink(email);
      setMessage('Open the link in your email to continue.');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.keyboard}
      >
        <View style={styles.content}>
          <Text style={styles.wordmark}>Exposure</Text>
          <View style={styles.intro}>
            <Text style={styles.title}>Your photos, everywhere.</Text>
            <Text style={styles.body}>Sign in to sync originals and edits, or keep shooting offline.</Text>
          </View>

          <View style={styles.form}>
            <TextInput
              value={email}
              onChangeText={setEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              returnKeyType="send"
              onSubmitEditing={signIn}
              placeholder="Email address"
              placeholderTextColor={colors.muted}
              style={styles.input}
              accessibilityLabel="Email address"
            />
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
              onPress={signIn}
              disabled={busy}
            >
              {busy ? (
                <ActivityIndicator color={colors.limeInk} />
              ) : (
                <Text style={styles.primaryText}>Continue with email</Text>
              )}
            </Pressable>
            {message ? (
              <Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text>
            ) : null}
          </View>

          <Pressable
            accessibilityRole="button"
            style={({ pressed }) => [styles.offline, pressed && styles.pressed]}
            onPress={finish}
          >
            <Text style={styles.offlineText}>Continue offline</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.canvas },
  keyboard: { flex: 1 },
  content: { flex: 1, paddingHorizontal: 24, paddingTop: 16, paddingBottom: 16 },
  wordmark: { color: colors.ink, fontFamily: 'ZenOldMincho_700Bold', fontSize: 22 },
  intro: { flex: 1, justifyContent: 'center' },
  title: { color: colors.ink, fontFamily: 'ZenOldMincho_700Bold', fontSize: 36, lineHeight: 44 },
  body: { color: colors.muted, fontSize: 16, lineHeight: 23, marginTop: 12, maxWidth: 360 },
  form: { gap: 10 },
  input: {
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: colors.panel,
    color: colors.ink,
    fontSize: 16,
    paddingHorizontal: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.line,
  },
  primary: {
    minHeight: 52,
    borderRadius: 12,
    backgroundColor: colors.lime,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: colors.limeInk, fontSize: 15, fontWeight: '800' },
  message: { color: colors.ink, fontSize: 13, lineHeight: 18, textAlign: 'center' },
  offline: { minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  offlineText: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.72 },
});
