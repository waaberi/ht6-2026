import { ZenOldMincho_700Bold } from '@expo-google-fonts/zen-old-mincho/700Bold';
import { randomUUID } from 'expo-crypto';
import { useFonts } from 'expo-font';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, BackHandler, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';

import { TabBar, type MainTab } from './src/components/TabBar';
import { colors } from './src/components/theme';
import { CameraScreen } from './src/screens/CameraScreen';
import { ChatScreen } from './src/screens/ChatScreen';
import { LibraryScreen } from './src/screens/LibraryScreen';
import { hasCompletedOnboarding, OnboardingScreen } from './src/screens/OnboardingScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';
import { StudioScreen } from './src/screens/StudioScreen';
import type { LibraryChatMessage } from './src/domain/libraryChat';
import { sendLibraryChat } from './src/services/api';
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
  const [chatMessages, setChatMessages] = useState<LibraryChatMessage[]>([]);
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState<string>();
  const chatBusyRef = useRef(false);
  const chatRequestEpochRef = useRef(0);
  const { loading, ownerId, photos, analyses } = useExposure();

  useEffect(() => {
    chatRequestEpochRef.current += 1;
    chatBusyRef.current = false;
    setChatMessages([]);
    setChatBusy(false);
    setChatError(undefined);
  }, [ownerId]);

  useEffect(() => {
    if (!studioOpen) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      setStudioOpen(false);
      return true;
    });
    return () => subscription.remove();
  }, [studioOpen]);

  const sendChatMessage = async (question: string, attachedPhotoIds: string[]) => {
    if (chatBusyRef.current || !question.trim()) return false;
    const requestEpoch = ++chatRequestEpochRef.current;
    const requestOwnerId = ownerId;
    const priorMessages = chatMessages;
    const userMessage: LibraryChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: question.trim(),
      createdAt: new Date().toISOString(),
      attachedPhotoIds: attachedPhotoIds.slice(0, 4),
    };
    chatBusyRef.current = true;
    setChatBusy(true);
    setChatError(undefined);
    setChatMessages([...priorMessages, userMessage]);
    try {
      const result = await sendLibraryChat({
        question: userMessage.content,
        history: priorMessages,
        photos,
        analyses,
        attachedPhotoIds: userMessage.attachedPhotoIds,
      });
      if (chatRequestEpochRef.current !== requestEpoch || ownerId !== requestOwnerId) return false;
      const assistantMessage: LibraryChatMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: result.answer,
        createdAt: new Date().toISOString(),
        attachedPhotoIds: [],
      };
      setChatMessages((current) => [...current, assistantMessage]);
      return true;
    } catch (caught) {
      if (chatRequestEpochRef.current !== requestEpoch || ownerId !== requestOwnerId) return false;
      setChatMessages((current) => current.filter((message) => message.id !== userMessage.id));
      setChatError(caught instanceof Error ? caught.message : 'Gemini could not answer right now.');
      return false;
    } finally {
      if (chatRequestEpochRef.current === requestEpoch && ownerId === requestOwnerId) {
        chatBusyRef.current = false;
        setChatBusy(false);
      }
    }
  };

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
        {tab === 'chat' ? <ChatScreen messages={chatMessages} busy={chatBusy} error={chatError} onSend={sendChatMessage} /> : null}
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
