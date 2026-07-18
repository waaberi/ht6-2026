import { StatusBar } from 'expo-status-bar';
import React, { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { TabBar, type MainTab } from './src/components/TabBar';
import { colors } from './src/components/theme';
import { CameraScreen } from './src/screens/CameraScreen';
import { LibraryScreen } from './src/screens/LibraryScreen';
import { LooksScreen } from './src/screens/LooksScreen';
import { PortfolioScreen } from './src/screens/PortfolioScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { StudioScreen } from './src/screens/StudioScreen';
import { ExposureProvider, useExposure } from './src/state/ExposureContext';

export default function App() {
  return <ExposureProvider><ExposureApp /></ExposureProvider>;
}

function ExposureApp() {
  const [tab, setTab] = useState<MainTab>('camera');
  const [studioOpen, setStudioOpen] = useState(false);
  const { loading } = useExposure();

  if (loading) return <View style={styles.loading}><ActivityIndicator color={colors.lime} /></View>;
  if (studioOpen) return <><StudioScreen onClose={() => setStudioOpen(false)} /><StatusBar style="light" /></>;

  return (
    <View style={styles.container}>
      <View style={styles.content}>
        {tab === 'camera' ? <CameraScreen onOpenStudio={() => setStudioOpen(true)} /> : null}
        {tab === 'library' ? <LibraryScreen onOpenStudio={() => setStudioOpen(true)} /> : null}
        {tab === 'portfolio' ? <PortfolioScreen /> : null}
        {tab === 'looks' ? <LooksScreen /> : null}
        {tab === 'settings' ? <SettingsScreen /> : null}
      </View>
      <TabBar active={tab} onChange={setTab} />
      <StatusBar style="light" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.canvas,
  },
  content: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.canvas },
});
