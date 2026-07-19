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
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, layout, radii, spacing, typography } from '../components/theme';
import { useAuthSession } from '../state/AuthContext';

const ONBOARDING_COMPLETE_KEY = 'exposure.onboarding.complete.v1';
const ONBOARDING_VIDEO = require('../../assets/Exposureonboardht6.mp4');
const TOTAL_STEPS = 3;
type OnboardingStep = 0 | 1 | 2;

export const hasCompletedOnboarding = async () =>
  (await AsyncStorage.getItem(ONBOARDING_COMPLETE_KEY)) === 'true';

export const completeOnboarding = () =>
  AsyncStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');

export const resetOnboarding = () =>
  AsyncStorage.removeItem(ONBOARDING_COMPLETE_KEY);

export const OnboardingScreen = ({ onComplete }: { onComplete: () => void }) => {
  const { configured, signIn: signInWithAuth0, user } = useAuthSession();
  const [step, setStep] = useState<OnboardingStep>(0);
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
    if (user) void finish();
  }, [user]);

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
    setBusy(true);
    setMessage(undefined);
    try {
      await signInWithAuth0();
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
              {step < 2 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityHint="Open the Exposure camera without finishing setup"
                  hitSlop={12}
                  onPress={finish}
                  style={({ pressed }) => [styles.skipButton, pressed && styles.controlPressed]}
                  testID="onboarding-skip"
                >
                  <Text style={styles.skipText}>Skip</Text>
                </Pressable>
              ) : null}
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
                      detail="Feedback grounded in this photo’s light, focus and composition."
                    />
                    <FeatureRow
                      icon="sparkles-outline"
                      title="Generate"
                      detail="Amplify details or expand the frame with editable AI layers."
                    />
                    <FeatureRow
                      icon="color-palette-outline"
                      title="Looks"
                      detail="Reusable styles from 3–8 reference photos."
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
                    <Pressable
                      accessibilityRole="button"
                      accessibilityHint="Opens secure Auth0 login with Google and email options"
                      accessibilityState={{ disabled: busy || !configured, busy }}
                      style={({ pressed }) => [
                        styles.primary,
                        pressed && styles.primaryPressed,
                        (busy || !configured) && styles.disabled,
                      ]}
                      onPress={signIn}
                      disabled={busy || !configured}
                      testID="onboarding-auth0-submit"
                    >
                      {busy ? (
                        <ActivityIndicator color={colors.onPrimary} />
                      ) : (
                        <Text style={styles.primaryText}>Continue with Google or email</Text>
                      )}
                    </Pressable>
                    {!configured ? (
                      <Text accessibilityRole="alert" style={[styles.message, styles.errorMessage]}>
                        Auth0 is not configured for this build.
                      </Text>
                    ) : null}
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
                      Auth0 handles sign-in; location stays private unless you choose otherwise.
                    </Text>
                  </View>

                  <View style={styles.footer}>
                    <ProgressIndicator current={step} />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityHint="Use Exposure without cloud sync"
                      style={({ pressed }) => [styles.offline, pressed && styles.controlPressed]}
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
  skipButton: { minHeight: 48, borderRadius: radii.sm, justifyContent: 'center', paddingHorizontal: spacing.xs },
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
  primary: {
    minHeight: 52,
    borderRadius: 10,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: colors.onPrimary, fontSize: 15, fontWeight: '800' },
  primaryPressed: { backgroundColor: colors.primaryPressed },
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
    backgroundColor: colors.controlSurface,
    borderWidth: 1,
    borderColor: colors.outline,
  },
  offlineText: { color: colors.text, fontSize: 15, fontWeight: '700' },
  backButton: { minHeight: 48, borderRadius: radii.sm, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.xxs },
  backText: { color: colors.textSecondary, fontSize: 14, fontWeight: '700' },
  controlPressed: { backgroundColor: colors.controlPressed },
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
    style={({ pressed }) => [styles.primary, pressed && styles.primaryPressed]}
    testID={testID}
  >
    <Text style={styles.primaryText}>{label}</Text>
  </Pressable>
);

const BackButton = ({ onPress }: { onPress: () => void }) => (
  <Pressable
    accessibilityRole="button"
    onPress={onPress}
    style={({ pressed }) => [styles.backButton, pressed && styles.controlPressed]}
    testID="onboarding-back"
  >
    <Ionicons accessibilityElementsHidden name="chevron-back" size={16} color={colors.textSecondary} />
    <Text style={styles.backText}>Back</Text>
  </Pressable>
);
