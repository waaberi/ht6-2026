import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, layout, spacing, typography } from '../components/theme';
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
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'error' }>();
  const completedRef = useRef(false);

  const finish = async () => {
    if (completedRef.current) return;
    completedRef.current = true;
    await completeOnboarding();
    onComplete();
  };

  useEffect(() => {
    const stopLinks = listenForAuthLinks((error) => setMessage({ text: error.message, tone: 'error' }));
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
      setMessage({ text: 'Check your email to continue.', tone: 'info' });
    } catch (caught) {
      setMessage({
        text: caught instanceof Error ? caught.message : 'Sign-in failed.',
        tone: 'error',
      });
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
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <View style={styles.content}>
            <Text accessibilityRole="header" style={styles.wordmark}>Exposure</Text>
            <View style={styles.intro}>
              <Text style={styles.title}>Keep your photos in sync.</Text>
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
                placeholderTextColor={colors.textSecondary}
                style={[styles.input, message?.tone === 'error' && styles.inputError]}
                accessibilityLabel="Email address"
                accessibilityHint="A sign-in link will be sent to this address"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: busy, busy }}
                style={({ pressed }) => [
                  styles.primary,
                  busy && styles.disabled,
                  pressed && styles.pressed,
                ]}
                onPress={signIn}
                disabled={busy}
              >
                {busy ? (
                  <ActivityIndicator color={colors.onPrimary} />
                ) : (
                  <Text style={styles.primaryText}>Continue with email</Text>
                )}
              </Pressable>
              {message ? (
                <Text
                  accessibilityLiveRegion="polite"
                  style={[styles.message, message.tone === 'error' && styles.errorMessage]}
                >
                  {message.text}
                </Text>
              ) : null}
            </View>

            <Pressable
              accessibilityRole="button"
              accessibilityHint="Use Exposure without cloud sync"
              style={({ pressed }) => [styles.offline, pressed && styles.pressed]}
              onPress={finish}
            >
              <Text style={styles.offlineText}>Continue offline</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  keyboard: { flex: 1 },
  scrollContent: { flexGrow: 1 },
  content: {
    flex: 1,
    width: '100%',
    maxWidth: layout.formMaxWidth,
    alignSelf: 'center',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.md,
  },
  wordmark: { color: colors.text, fontFamily: typography.displayFamily, ...typography.title },
  intro: { flex: 1, minHeight: 180, justifyContent: 'center' },
  title: { color: colors.text, fontFamily: typography.displayFamily, fontSize: 36, lineHeight: 44 },
  form: { gap: spacing.sm },
  input: {
    minHeight: 52,
    borderRadius: 10,
    backgroundColor: colors.surface,
    color: colors.text,
    fontSize: 16,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderColor: colors.outline,
  },
  inputError: { borderColor: colors.error },
  primary: {
    minHeight: 52,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: colors.onPrimary, fontSize: 15, fontWeight: '800' },
  message: { color: colors.info, ...typography.label, textAlign: 'center' },
  errorMessage: { color: colors.error },
  offline: { minHeight: 52, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  offlineText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.78 },
  disabled: { opacity: 0.42 },
});
