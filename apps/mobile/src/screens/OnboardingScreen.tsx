import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useVideoPlayer, VideoView } from 'expo-video';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  AppState,
  BackHandler,
  Easing,
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

import { colors, layout, radii, spacing, typography } from '../components/theme';
import { listenForAuthLinks, sendMagicLink } from '../services/auth';
import { supabase } from '../services/supabase';

const ONBOARDING_COMPLETE_KEY = 'exposure.onboarding.complete.v1';
const ONBOARDING_VIDEO = require('../../assets/Exposureonboardht6.mp4');
const TOTAL_STEPS = 3;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type OnboardingStep = 0 | 1 | 2;

export const hasCompletedOnboarding = async () =>
  (await AsyncStorage.getItem(ONBOARDING_COMPLETE_KEY)) === 'true';

export const completeOnboarding = () =>
  AsyncStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');

export const resetOnboarding = () =>
  AsyncStorage.removeItem(ONBOARDING_COMPLETE_KEY);

export const OnboardingScreen = ({ onComplete }: { onComplete: () => void }) => {
  const [step, setStep] = useState<OnboardingStep>(0);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: 'info' | 'error' }>();
  const [reduceMotion, setReduceMotion] = useState(true);
  const completedRef = useRef(false);
  const transitioningRef = useRef(false);
  const pageMotion = useRef(new Animated.Value(1)).current;

  const finish = async () => {
    if (completedRef.current) return;
    completedRef.current = true;
    await completeOnboarding();
    onComplete();
  };

  const goToStep = useCallback((nextStep: OnboardingStep) => {
    if (nextStep === step || transitioningRef.current) return;
    if (reduceMotion) {
      setStep(nextStep);
      return;
    }

    transitioningRef.current = true;
    Animated.timing(pageMotion, {
      toValue: 0,
      duration: 80,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (!finished) {
        transitioningRef.current = false;
        return;
      }
      setStep(nextStep);
      pageMotion.setValue(0);
      Animated.timing(pageMotion, {
        toValue: 1,
        duration: 160,
        easing: Easing.out(Easing.poly(4)),
        useNativeDriver: true,
      }).start(() => {
        transitioningRef.current = false;
      });
    });
  }, [pageMotion, reduceMotion, step]);

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

  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((enabled) => {
      if (mounted) setReduceMotion(enabled);
    });
    const subscription = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (step === 0) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      goToStep((step - 1) as OnboardingStep);
      return true;
    });
    return () => subscription.remove();
  }, [goToStep, step]);

  const signIn = async () => {
    const normalizedEmail = email.trim();
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      setMessage({ text: 'Enter a valid email address.', tone: 'error' });
      return;
    }
    setBusy(true);
    setMessage(undefined);
    try {
      await sendMagicLink(normalizedEmail);
      setMessage({ text: 'Magic link sent. Open your email to finish signing in.', tone: 'info' });
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
            <View style={styles.topBar}>
              <Text style={styles.wordmark}>Exposure</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityHint="Open the Exposure camera without finishing setup"
                hitSlop={12}
                onPress={finish}
                style={({ pressed }) => [styles.skipButton, pressed && styles.pressed]}
                testID="onboarding-skip"
              >
                <Text style={styles.skipText}>Skip</Text>
              </Pressable>
            </View>

            <Animated.View
              style={[
                styles.step,
                {
                  opacity: pageMotion,
                  transform: [{
                    translateY: pageMotion.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }),
                  }],
                },
              ]}
            >
              {step === 0 ? (
                <>
                  <View
                    style={styles.videoFrame}
                  >
                    <OnboardingVideo reduceMotion={reduceMotion} />
                  </View>
                  <View style={styles.welcomeCopy}>
                    <Text accessibilityRole="header" style={styles.title}>A camera that teaches.</Text>
                    <Text style={styles.body}>
                      Familiar camera controls first. Evidence-backed coaching when you want it.
                    </Text>
                  </View>
                  <View style={styles.footer}>
                    <ProgressIndicator current={step} />
                    <PrimaryButton
                      label="Continue"
                      onPress={() => goToStep(1)}
                      testID="onboarding-next"
                    />
                  </View>
                </>
              ) : null}

              {step === 1 ? (
                <>
                  <View style={styles.promiseHeader}>
                    <Text accessibilityRole="header" style={styles.title}>Shoot first. Refine with intent.</Text>
                  </View>
                  <View style={styles.featureList}>
                    <FeatureRow
                      icon="scan-outline"
                      title="Coach"
                      detail="Measured feedback for this photo—not a generic score."
                    />
                    <FeatureRow
                      icon="options-outline"
                      title="Adjust"
                      detail="Crop, rotate, light, color and detail in one place."
                    />
                    <FeatureRow
                      icon="color-palette-outline"
                      title="Looks"
                      detail="Reusable visual styles with strength control. Your original stays untouched."
                    />
                  </View>
                  <View style={styles.footer}>
                    <ProgressIndicator current={step} />
                    <PrimaryButton
                      label="Continue"
                      onPress={() => goToStep(2)}
                      testID="onboarding-setup"
                    />
                    <BackButton onPress={() => goToStep(0)} />
                  </View>
                </>
              ) : null}

              {step === 2 ? (
                <>
                  <View style={styles.accountHeader}>
                    <View style={styles.accountIcon}>
                      <Ionicons name="cloud-outline" size={28} color={colors.text} />
                    </View>
                    <Text accessibilityRole="header" style={styles.title}>Sync across devices.</Text>
                    <Text style={styles.body}>
                      Sign in to keep originals, edits and Looks available everywhere.
                    </Text>
                  </View>

                  <View style={styles.form}>
                    <TextInput
                      value={email}
                      onChangeText={(nextEmail) => {
                        setEmail(nextEmail);
                        if (message?.tone === 'error') setMessage(undefined);
                      }}
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
                      accessibilityHint="A magic sign-in link will be sent to this address"
                      testID="onboarding-email"
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
                      testID="onboarding-email-submit"
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

                  <View style={styles.privacyNote}>
                    <Ionicons name="lock-closed-outline" size={16} color={colors.textSecondary} />
                    <Text style={styles.privacyText}>
                      Location stays private unless you choose otherwise.
                    </Text>
                  </View>

                  <View style={styles.footer}>
                    <ProgressIndicator current={step} />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityHint="Use Exposure without cloud sync"
                      style={({ pressed }) => [styles.offline, pressed && styles.pressed]}
                      onPress={finish}
                      testID="onboarding-offline"
                    >
                      <Text style={styles.offlineText}>Continue offline</Text>
                    </Pressable>
                    <BackButton onPress={() => goToStep(1)} />
                  </View>
                </>
              ) : null}
            </Animated.View>

          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
};

const OnboardingVideo = ({ reduceMotion }: { reduceMotion: boolean }) => {
  const videoPlayer = useVideoPlayer(ONBOARDING_VIDEO, (player) => {
    player.loop = false;
    player.muted = true;
  });

  useEffect(() => {
    const syncPlayback = (state: string | null) => {
      if (state !== 'active') {
        videoPlayer.pause();
        videoPlayer.currentTime = 0;
        return;
      }

      if (reduceMotion) {
        videoPlayer.pause();
        return;
      }

      videoPlayer.play();
    };

    syncPlayback(AppState.currentState);
    const subscription = AppState.addEventListener('change', syncPlayback);
    return () => subscription.remove();
  }, [reduceMotion, videoPlayer]);

  return (
    <VideoView
      accessibilityElementsHidden
      contentFit="contain"
      importantForAccessibility="no-hide-descendants"
      nativeControls={false}
      player={videoPlayer}
      pointerEvents="none"
      style={styles.video}
      surfaceType={Platform.OS === 'android' ? 'textureView' : undefined}
    />
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
    paddingTop: spacing.sm,
    paddingBottom: spacing.lg,
  },
  topBar: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  wordmark: { color: colors.text, fontFamily: typography.displayFamily, ...typography.title },
  skipButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.xs },
  skipText: { color: colors.textSecondary, fontSize: 14, fontWeight: '700' },
  step: { flex: 1 },
  videoFrame: {
    width: '100%',
    aspectRatio: 16 / 9,
    maxHeight: 250,
    marginTop: spacing.md,
    borderRadius: radii.lg,
    overflow: 'hidden',
    backgroundColor: colors.background,
  },
  video: { width: '100%', height: '100%' },
  welcomeCopy: { flex: 1, justifyContent: 'center', minHeight: 176, paddingVertical: spacing.lg },
  promiseHeader: { paddingTop: spacing.xl, paddingBottom: spacing.lg },
  accountHeader: { paddingTop: spacing.xl, paddingBottom: spacing.lg },
  accountIcon: {
    width: 52,
    height: 52,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    marginBottom: spacing.lg,
  },
  title: { color: colors.text, fontFamily: typography.displayFamily, fontSize: 34, lineHeight: 41 },
  body: { color: colors.textSecondary, fontSize: 16, lineHeight: 24, marginTop: spacing.base },
  featureList: { flex: 1, justifyContent: 'center', gap: spacing.lg, paddingBottom: spacing.lg },
  featureRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.base },
  featureIcon: {
    width: 46,
    height: 46,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  featureCopy: { flex: 1, paddingTop: 1 },
  featureTitle: { color: colors.text, fontSize: 16, lineHeight: 21, fontWeight: '800' },
  featureDetail: { color: colors.textSecondary, fontSize: 14, lineHeight: 20, marginTop: spacing.xs },
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
  privacyNote: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm, marginTop: spacing.md },
  privacyText: { flex: 1, color: colors.textSecondary, ...typography.caption },
  footer: { marginTop: 'auto', paddingTop: spacing.lg },
  progress: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xs, marginBottom: spacing.md },
  progressDot: { width: 8, height: 8, borderRadius: radii.pill, backgroundColor: colors.disabled },
  progressDotActive: { width: 24, backgroundColor: colors.primary },
  offline: {
    minHeight: 52,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  offlineText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  backButton: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xxs },
  backText: { color: colors.textSecondary, fontSize: 14, fontWeight: '700' },
  pressed: { opacity: 0.78 },
  disabled: { opacity: 0.42 },
});

const ProgressIndicator = ({ current }: { current: OnboardingStep }) => (
  <View
    accessibilityRole="progressbar"
    accessibilityValue={{ min: 1, max: TOTAL_STEPS, now: current + 1 }}
    style={styles.progress}
  >
    {Array.from({ length: TOTAL_STEPS }, (_, index) => (
      <View key={index} style={[styles.progressDot, index === current && styles.progressDotActive]} />
    ))}
  </View>
);

const FeatureRow = ({ icon, title, detail }: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  title: string;
  detail: string;
}) => (
  <View style={styles.featureRow}>
    <View style={styles.featureIcon}>
      <Ionicons accessibilityElementsHidden name={icon} size={23} color={colors.text} />
    </View>
    <View style={styles.featureCopy}>
      <Text style={styles.featureTitle}>{title}</Text>
      <Text style={styles.featureDetail}>{detail}</Text>
    </View>
  </View>
);

const PrimaryButton = ({ label, onPress, testID }: { label: string; onPress: () => void; testID: string }) => (
  <Pressable
    accessibilityRole="button"
    onPress={onPress}
    style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
    testID={testID}
  >
    <Text style={styles.primaryText}>{label}</Text>
  </Pressable>
);

const BackButton = ({ onPress }: { onPress: () => void }) => (
  <Pressable
    accessibilityRole="button"
    onPress={onPress}
    style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}
    testID="onboarding-back"
  >
    <Ionicons accessibilityElementsHidden name="chevron-back" size={16} color={colors.textSecondary} />
    <Text style={styles.backText}>Back</Text>
  </Pressable>
);
