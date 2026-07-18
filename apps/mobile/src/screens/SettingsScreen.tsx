import { MaterialCommunityIcons } from '@expo/vector-icons';
import type { Session } from '@supabase/supabase-js';
import { DeviceMotion } from 'expo-sensors';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '../components/theme';
import {
  defaultPreferences,
  loadPreferences,
  savePreferences as persistPreferences,
  type CameraPreferences,
  type ExposurePreferences,
} from '../data/preferences';
import { resolveApiUrl } from '../domain/apiConfiguration';
import { sendMagicLink, signOut } from '../services/auth';
import { supabase } from '../services/supabase';
import { persistPreferences as persistPreferencesToCloud } from '../services/sync';
import { useExposure } from '../state/ExposureContext';

export const SettingsScreen = () => {
  const insets = useSafeAreaInsets();
  const configuredApiUrl = resolveApiUrl(
    process.env.EXPO_PUBLIC_LAUNCHER_API_URL,
    process.env.EXPO_PUBLIC_API_URL,
    undefined,
  );
  const { photos, syncing, syncError, synchronize } = useExposure();
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [preferences, setPreferences] = useState<ExposurePreferences>(defaultPreferences);
  const [message, setMessage] = useState<string>();
  const [cameraMessage, setCameraMessage] = useState<string>();
  const preferencesRef = useRef(defaultPreferences);
  const sessionRef = useRef<Session | null>(null);
  const preferenceWriteQueue = useRef(Promise.resolve());

  useEffect(() => {
    void loadPreferences().then((stored) => {
      preferencesRef.current = stored;
      setPreferences(stored);
    });
    if (!supabase) return;
    const updateSession = (next: Session | null) => {
      sessionRef.current = next;
      setSession(next);
    };
    void supabase.auth.getSession().then(({ data }) => updateSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => updateSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  const savePreferences = (next: ExposurePreferences) => {
    preferencesRef.current = next;
    setPreferences(next);
    preferenceWriteQueue.current = preferenceWriteQueue.current.then(async () => {
      await persistPreferences(next);
      if (sessionRef.current) await persistPreferencesToCloud(next);
    }).catch((caught: unknown) => {
      setMessage(caught instanceof Error ? caught.message : 'Preference sync failed.');
    });
  };

  const updatePreferences = (changes: Partial<ExposurePreferences>) => {
    savePreferences({ ...preferencesRef.current, ...changes });
  };

  const updateCamera = (changes: Partial<CameraPreferences>) => {
    savePreferences({
      ...preferencesRef.current,
      camera: { ...preferencesRef.current.camera, ...changes },
    });
  };

  const updateDraft = (changes: Partial<ExposurePreferences>) => {
    const next = { ...preferencesRef.current, ...changes };
    preferencesRef.current = next;
    setPreferences(next);
  };

  const updateLevel = (showLevel: boolean) => {
    if (!showLevel) {
      updateCamera({ showLevel: false });
      return;
    }
    setCameraMessage(undefined);
    void (async () => {
      if (!await DeviceMotion.isAvailableAsync()) throw new Error('Level is not available on this device.');
      const permission = await DeviceMotion.requestPermissionsAsync();
      if (!permission.granted) throw new Error('Motion access is needed for the level.');
      updateCamera({ showLevel: true });
    })().catch((caught: unknown) => {
      setCameraMessage(caught instanceof Error ? caught.message : 'Level is unavailable.');
    });
  };

  const signIn = async () => {
    setMessage(undefined);
    try {
      await sendMagicLink(email);
      setMessage('Open the link in your email to finish signing in.');
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : 'Sign-in failed.');
    }
  };

  const queuedCount = photos.filter((photo) => photo.syncState !== 'synced').length;
  const cloudReady = !syncing && !syncError && queuedCount === 0;
  const cloudStatus = syncing
    ? 'Syncing…'
    : syncError
      ? 'Sync needs attention'
      : queuedCount === 0
        ? 'Up to date'
        : `${queuedCount} waiting to sync`;

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + 14, paddingBottom: insets.bottom + 36 }]}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.title}>Settings</Text>

      <Section title="Account & sync">
        {session ? (
          <>
            <View style={styles.accountRow}>
              <View style={[styles.statusIcon, cloudReady && styles.statusIconReady]}>
                <MaterialCommunityIcons
                  name={cloudReady ? 'cloud-check-outline' : syncError ? 'cloud-alert-outline' : syncing ? 'cloud-sync-outline' : 'cloud-upload-outline'}
                  size={22}
                  color={cloudReady ? colors.success : colors.ink}
                />
              </View>
              <View style={styles.accountText}>
                <Text numberOfLines={1} style={styles.accountEmail}>{session.user.email}</Text>
                <Text style={styles.accountStatus}>{cloudStatus}</Text>
              </View>
            </View>
            <View style={styles.accountActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ busy: syncing }}
                disabled={syncing}
                style={({ pressed }) => [styles.textButton, styles.accountActionsButton, pressed && styles.pressed]}
                onPress={() => void synchronize()}
              >
                <Text style={styles.textButtonLabel}>{syncing ? 'Syncing…' : 'Sync now'}</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                style={({ pressed }) => [styles.textButton, styles.accountActionsButton, pressed && styles.pressed]}
                onPress={() => void signOut().catch((caught: unknown) => setMessage(caught instanceof Error ? caught.message : 'Sign-out failed.'))}
              >
                <Text style={styles.textButtonLabel}>Sign out</Text>
              </Pressable>
            </View>
            {syncError ? <Text accessibilityRole="alert" style={styles.message}>{syncError}</Text> : null}
          </>
        ) : (
          <>
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
              style={({ pressed }) => [styles.primaryButton, pressed && styles.pressed]}
              onPress={signIn}
            >
              <Text style={styles.primaryButtonText}>Sign in to sync</Text>
            </Pressable>
          </>
        )}
        {message ? <Text accessibilityLiveRegion="polite" style={styles.message}>{message}</Text> : null}
      </Section>

      <Section title="Camera">
        <SettingRow label="Grid" value={preferences.camera.showGrid} onChange={(showGrid) => updateCamera({ showGrid })} />
        <SettingRow label="Level guide" value={preferences.camera.showLevel} onChange={updateLevel} />
        <SettingRow label="Mirror selfies" value={preferences.camera.mirrorSelfies} onChange={(mirrorSelfies) => updateCamera({ mirrorSelfies })} />
        <SettingRow label="Preserve capture controls" value={preferences.camera.preserveCaptureSettings} onChange={(preserveCaptureSettings) => updateCamera({ preserveCaptureSettings })} last />
        {cameraMessage ? <Text accessibilityRole="alert" style={styles.message}>{cameraMessage}</Text> : null}
      </Section>

      <Section title="Coach">
        <ChoiceRow
          label="Experience"
          value={preferences.skillLevel}
          options={[{ label: 'Beginner', value: 'beginner' }, { label: 'Enthusiast', value: 'enthusiast' }, { label: 'Pro', value: 'professional' }]}
          onChange={(skillLevel) => updatePreferences({ skillLevel: skillLevel as ExposurePreferences['skillLevel'] })}
        />
        <ChoiceRow
          label="Feedback"
          value={preferences.detail}
          options={[{ label: 'Concise', value: 'concise' }, { label: 'Detailed', value: 'detailed' }]}
          onChange={(detail) => updatePreferences({ detail: detail as ExposurePreferences['detail'] })}
          last
        />
      </Section>

      <Section title="Privacy & export">
        <SettingRow
          label="Include camera metadata"
          detail="Camera, lens, exposure and capture time"
          value={preferences.exportMetadata}
          onChange={(exportMetadata) => updatePreferences({ exportMetadata })}
        />
        <SettingRow
          label="Include location"
          value={preferences.exportGps}
          onChange={(exportGps) => updatePreferences({ exportGps })}
          last
        />
      </Section>

      {__DEV__ ? (
        <Section title="Developer">
          <TextInput
            value={preferences.apiUrl}
            onChangeText={(apiUrl) => updateDraft({ apiUrl })}
            onEndEditing={() => savePreferences(preferencesRef.current)}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder={configuredApiUrl || 'API URL'}
            placeholderTextColor={colors.muted}
            style={[styles.input, styles.developerInput]}
            accessibilityLabel="Development API URL"
          />
        </Section>
      ) : null}
    </ScrollView>
  );
};

const Section = ({ title, children }: React.PropsWithChildren<{ title: string }>) => (
  <View style={styles.sectionGroup}>
    <Text style={styles.sectionTitle}>{title}</Text>
    <View style={styles.section}>{children}</View>
  </View>
);

const ChoiceRow = ({ label, value, options, onChange, last = false }: {
  label: string;
  value: string;
  options: Array<{ label: string; value: string }>;
  onChange: (value: string) => void;
  last?: boolean;
}) => (
  <View style={[styles.choiceBlock, last && styles.lastRow]}>
    <Text style={styles.rowLabel}>{label}</Text>
    <View accessibilityRole="radiogroup" style={styles.segmented}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: selected }}
            style={({ pressed }) => [styles.segment, selected && styles.segmentSelected, pressed && styles.pressed]}
            onPress={() => onChange(option.value)}
          >
            <Text style={[styles.segmentLabel, selected && styles.segmentLabelSelected]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  </View>
);

const SettingRow = ({ label, detail, value, onChange, last = false }: {
  label: string;
  detail?: string;
  value: boolean;
  onChange: (value: boolean) => void;
  last?: boolean;
}) => (
  <View style={[styles.settingRow, last && styles.lastRow]}>
    <View style={styles.settingCopy}>
      <Text style={styles.rowLabel}>{label}</Text>
      {detail ? <Text style={styles.rowDetail}>{detail}</Text> : null}
    </View>
    <Switch
      value={value}
      onValueChange={onChange}
      trackColor={{ false: colors.outline, true: colors.primary }}
      thumbColor={value ? colors.onPrimary : colors.textSecondary}
      accessibilityLabel={label}
    />
  </View>
);

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  content: { width: '100%', maxWidth: 720, alignSelf: 'center', paddingHorizontal: 18 },
  title: { color: colors.ink, fontFamily: 'ZenOldMincho_700Bold', fontSize: 32, lineHeight: 40, marginBottom: 22 },
  sectionGroup: { marginBottom: 20 },
  sectionTitle: { color: colors.muted, fontSize: 13, fontWeight: '700', marginLeft: 4, marginBottom: 8 },
  section: { borderRadius: 14, backgroundColor: colors.surface, overflow: 'hidden' },
  accountRow: { minHeight: 68, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 12 },
  statusIcon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.panelRaised },
  statusIconReady: { backgroundColor: 'rgba(97, 152, 142, 0.14)' },
  accountText: { flex: 1 },
  accountEmail: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  accountStatus: { color: colors.muted, fontSize: 12, marginTop: 3 },
  input: { minHeight: 52, borderRadius: 10, color: colors.text, backgroundColor: colors.background, fontSize: 15, paddingHorizontal: 14, marginHorizontal: 12, marginTop: 12, borderWidth: 1, borderColor: colors.outline },
  primaryButton: { minHeight: 52, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center', marginHorizontal: 12, marginTop: 10, marginBottom: 12 },
  primaryButtonText: { color: colors.onPrimary, fontSize: 14, fontWeight: '800' },
  textButton: { minHeight: 48, alignItems: 'center', justifyContent: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  accountActions: { flexDirection: 'row' },
  accountActionsButton: { flex: 1 },
  textButtonLabel: { color: colors.lime, fontSize: 14, fontWeight: '700' },
  message: { color: colors.ink, fontSize: 12, lineHeight: 18, paddingHorizontal: 14, paddingVertical: 10, textAlign: 'center' },
  choiceBlock: { paddingHorizontal: 12, paddingTop: 11, paddingBottom: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  rowLabel: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  rowDetail: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 2 },
  segmented: { minHeight: 52, flexDirection: 'row', borderRadius: 10, backgroundColor: colors.background, padding: 4, marginTop: 9 },
  segment: { flex: 1, minHeight: 44, borderRadius: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  segmentSelected: { backgroundColor: colors.primary },
  segmentLabel: { color: colors.muted, fontSize: 12, fontWeight: '700', textAlign: 'center' },
  segmentLabelSelected: { color: colors.onPrimary },
  settingRow: { minHeight: 60, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line },
  settingCopy: { flex: 1, paddingRight: 14 },
  lastRow: { borderBottomWidth: 0 },
  developerInput: { marginBottom: 12 },
  pressed: { opacity: 0.7 },
});
