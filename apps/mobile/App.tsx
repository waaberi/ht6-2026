import { ZenOldMincho_700Bold } from '@expo-google-fonts/zen-old-mincho/700Bold';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import { TabBar, type MainTab } from './src/components/TabBar';
import { colors } from './src/components/theme';
import { CameraScreen } from './src/screens/CameraScreen';
import { LibraryScreen } from './src/screens/LibraryScreen';
import { hasCompletedOnboarding, OnboardingScreen } from './src/screens/OnboardingScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { StudioScreen } from './src/screens/StudioScreen';
import { AuthProvider } from './src/state/AuthContext';
import { ExposureProvider, useExposure } from './src/state/ExposureContext';

export default function App() {
  const [fontsLoaded, fontError] = useFonts({ ZenOldMincho_700Bold });
  const [onboardingComplete, setOnboardingComplete] = useState<boolean>();

  useEffect(() => {
    void hasCompletedOnboarding().then(setOnboardingComplete);
  }, []);

  const ready = fontsLoaded || Boolean(fontError);
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <AuthProvider>
        {!ready || onboardingComplete === undefined ? (
          <LoadingScreen />
        ) : onboardingComplete ? (
          <ExposureProvider><ExposureApp /></ExposureProvider>
        ) : (
          <OnboardingScreen onComplete={() => setOnboardingComplete(true)} />
        )}
        <StatusBar style="light" backgroundColor={colors.background} />
      </AuthProvider>
    </SafeAreaProvider>
  );
}

function ExposureApp() {
  const [tab, setTab] = useState<MainTab>('camera');
  const [studioOpen, setStudioOpen] = useState(false);
  const { loading } = useExposure();

  useEffect(() => {
    if (!studioOpen) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setStudioOpen(false);
      return true;
    });
    return () => subscription.remove();
  }, [studioOpen]);

  if (loading) return <LoadingScreen />;
  if (studioOpen) return (
    <StudioScreen
      onClose={() => setStudioOpen(false)}
      onRetake={() => {
        setStudioOpen(false);
        setTab('camera');
      }}
    />
  );

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {tab === 'camera' ? <CameraScreen onOpenStudio={() => setStudioOpen(true)} onOpenLibrary={() => setTab('library')} /> : null}
        {tab === 'library' ? <LibraryScreen onOpenStudio={() => setStudioOpen(true)} onOpenCamera={() => setTab('camera')} /> : null}
        {tab === 'settings' ? <SettingsScreen /> : null}
      </View>
      <TabBar active={tab} onChange={setTab} />
    </View>
  );
}

const LoadingScreen = () => (
  <View style={styles.loading}>
    <ActivityIndicator color={colors.primary} />
  </View>
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  content: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background },
});
