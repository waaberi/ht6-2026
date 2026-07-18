import type { Session } from '@supabase/supabase-js';
import React, { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { colors } from '../components/theme';
import { loadPreferences, savePreferences as persistPreferences, type ExposurePreferences } from '../data/preferences';
import { supabase } from '../services/supabase';
import { persistPreferences as persistPreferencesToCloud } from '../services/sync';
import { useExposure } from '../state/ExposureContext';

export const SettingsScreen = () => {
  const { photos } = useExposure();
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState('');
  const [apiUrl, setApiUrl] = useState(process.env.EXPO_PUBLIC_API_URL ?? '');
  const [detail, setDetail] = useState<'concise' | 'detailed'>('detailed');
  const [skillLevel, setSkillLevel] = useState<ExposurePreferences['skillLevel']>('enthusiast');
  const [desiredMood, setDesiredMood] = useState('');
  const [exportMetadata, setExportMetadata] = useState(true);
  const [exportGps, setExportGps] = useState(false);
  const [recommendationFeedback, setRecommendationFeedback] = useState<ExposurePreferences['recommendationFeedback']>({ accepted: [], rejected: [] });
  const [message, setMessage] = useState<string>();

  useEffect(() => {
    void loadPreferences().then((preferences) => {
      setDetail(preferences.detail);
      setApiUrl(preferences.apiUrl);
      setSkillLevel(preferences.skillLevel);
      setDesiredMood(preferences.desiredMood);
      setExportMetadata(preferences.exportMetadata);
      setExportGps(preferences.exportGps);
      setRecommendationFeedback(preferences.recommendationFeedback);
    });
    if (!supabase) return;
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  const savePreferences = async (next: ExposurePreferences) => {
    setApiUrl(next.apiUrl); setDetail(next.detail); setSkillLevel(next.skillLevel); setDesiredMood(next.desiredMood);
    setExportMetadata(next.exportMetadata); setExportGps(next.exportGps); setRecommendationFeedback(next.recommendationFeedback);
    await persistPreferences(next);
    if (session) await persistPreferencesToCloud(next).catch((error: unknown) => setMessage(error instanceof Error ? error.message : 'Preference sync failed.'));
  };

  const updatePreferences = (changes: Partial<ExposurePreferences>) => savePreferences({
    apiUrl, detail, skillLevel, desiredMood, exportMetadata, exportGps, recommendationFeedback, ...changes,
  });

  const signIn = async () => {
    if (!supabase) return setMessage('Set the public Supabase environment variables to enable accounts.');
    const { error } = await supabase.auth.signInWithOtp({ email });
    setMessage(error ? error.message : 'Check your email for the Exposure sign-in link.');
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.eyebrow}>EXPOSURE</Text><Text style={styles.title}>Settings</Text>
      <Section title="Account">
        {session ? <><Text style={styles.account}>{session.user.email}</Text><Pressable onPress={() => supabase?.auth.signOut()}><Text style={styles.link}>Sign out</Text></Pressable></> : <><Text style={styles.body}>A private account syncs originals, versions, jobs and preferences through Supabase.</Text><TextInput value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" placeholder="you@example.com" placeholderTextColor={colors.muted} style={styles.input} /><Pressable style={styles.button} onPress={signIn}><Text style={styles.buttonText}>Email me a sign-in link</Text></Pressable></>}
        {message ? <Text style={styles.message}>{message}</Text> : null}
      </Section>
      <Section title="Compute service">
        <Text style={styles.body}>Use 10.0.2.2 for an Android emulator, or this machine’s LAN address for a physical device.</Text>
        <TextInput value={apiUrl} onChangeText={setApiUrl} onEndEditing={() => updatePreferences({ apiUrl })} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="http://10.0.2.2:8000" placeholderTextColor={colors.muted} style={styles.input} />
      </Section>
      <Section title="Coaching">
        <Text style={styles.label}>SKILL LEVEL</Text>
        <View style={styles.segmented}>{(['beginner', 'enthusiast', 'professional'] as const).map((value) => <Pressable key={value} style={[styles.segment, skillLevel === value && styles.segmentActive]} onPress={() => updatePreferences({ skillLevel: value })}><Text style={[styles.segmentText, skillLevel === value && styles.segmentTextActive]}>{value.toUpperCase()}</Text></Pressable>)}</View>
        <Text style={styles.label}>FEEDBACK DETAIL</Text>
        <View style={styles.segmented}>{(['concise', 'detailed'] as const).map((value) => <Pressable key={value} style={[styles.segment, detail === value && styles.segmentActive]} onPress={() => updatePreferences({ detail: value })}><Text style={[styles.segmentText, detail === value && styles.segmentTextActive]}>{value.toUpperCase()}</Text></Pressable>)}</View>
        <Text style={styles.label}>DESIRED MOOD</Text>
        <TextInput value={desiredMood} onChangeText={setDesiredMood} onEndEditing={() => updatePreferences({ desiredMood })} placeholder="e.g. quiet, cinematic, energetic" placeholderTextColor={colors.muted} style={styles.input} />
        <Text style={styles.feedbackStat}>{recommendationFeedback.accepted.length} accepted · {recommendationFeedback.rejected.length} rejected recommendations</Text>
      </Section>
      <Section title="Privacy and export">
        <SettingRow label="Include camera metadata" description="Camera, lens, exposure and capture time." value={exportMetadata} onChange={(value) => updatePreferences({ exportMetadata: value })} />
        <SettingRow label="Include GPS" description="Off by default. GPS is never sent to Gemini." value={exportGps} onChange={(value) => updatePreferences({ exportGps: value })} />
      </Section>
      <Section title="Local storage">
        <View style={styles.statRow}><Text style={styles.statValue}>{photos.length}</Text><Text style={styles.statLabel}>originals</Text><Text style={styles.statValue}>{photos.reduce((sum, photo) => sum + photo.versions.length, 0)}</Text><Text style={styles.statLabel}>versions</Text></View>
        <Text style={styles.body}>{photos.filter((photo) => photo.syncState !== 'synced').length} item(s) queued for sync. Local capture remains available offline.</Text>
      </Section>
      <Text style={styles.footer}>Exposure · com.ht62026.exposure{apiUrl ? ' · API configured' : ' · local mode'}</Text>
    </ScrollView>
  );
};

const Section = ({ title, children }: React.PropsWithChildren<{ title: string }>) => <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text>{children}</View>;
const SettingRow = ({ label, description, value, onChange }: { label: string; description: string; value: boolean; onChange: (value: boolean) => void }) => <View style={styles.settingRow}><View style={{ flex: 1 }}><Text style={styles.settingLabel}>{label}</Text><Text style={styles.settingDescription}>{description}</Text></View><Switch value={value} onValueChange={onChange} trackColor={{ false: colors.line, true: colors.lime }} thumbColor={colors.ink} /></View>;

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas }, content: { padding: 20, paddingBottom: 50 },
  eyebrow: { color: colors.lime, fontWeight: '900', fontSize: 9, letterSpacing: 2.2, marginTop: 6 }, title: { color: colors.ink, fontSize: 34, fontWeight: '900', marginTop: 5, marginBottom: 18 },
  section: { backgroundColor: colors.panel, padding: 16, borderWidth: 1, borderColor: colors.line, marginBottom: 12 }, sectionTitle: { color: colors.ink, fontSize: 16, fontWeight: '900', marginBottom: 12 },
  body: { color: colors.muted, fontSize: 12, lineHeight: 18 }, account: { color: colors.ink, fontSize: 13, fontWeight: '700' }, link: { color: colors.lime, fontSize: 11, fontWeight: '900', marginTop: 9 },
  input: { color: colors.ink, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.canvas, paddingHorizontal: 12, height: 44, marginTop: 12 }, button: { backgroundColor: colors.lime, minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 9 }, buttonText: { color: colors.limeInk, fontWeight: '900', fontSize: 11 }, message: { color: colors.amber, fontSize: 11, marginTop: 10 },
  label: { color: colors.muted, fontSize: 8, fontWeight: '900', letterSpacing: 1.2, marginTop: 10 }, segmented: { flexDirection: 'row', marginTop: 8, marginBottom: 8, borderWidth: 1, borderColor: colors.line }, segment: { flex: 1, paddingVertical: 10, paddingHorizontal: 3, alignItems: 'center' }, segmentActive: { backgroundColor: colors.lime }, segmentText: { color: colors.muted, fontWeight: '900', fontSize: 8 }, segmentTextActive: { color: colors.limeInk },
  feedbackStat: { color: colors.muted, fontSize: 9, marginTop: 10 },
  settingRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line }, settingLabel: { color: colors.ink, fontSize: 12, fontWeight: '700' }, settingDescription: { color: colors.muted, fontSize: 10, lineHeight: 15, marginTop: 2, paddingRight: 14 },
  statRow: { flexDirection: 'row', alignItems: 'baseline', gap: 7, marginBottom: 8 }, statValue: { color: colors.lime, fontSize: 24, fontWeight: '900', marginLeft: 8 }, statLabel: { color: colors.muted, fontSize: 9, textTransform: 'uppercase' }, footer: { color: colors.muted, fontSize: 9, textAlign: 'center', marginTop: 8 },
});
