import { randomUUID } from 'expo-crypto';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors } from '../components/theme';
import { loadStyleProfiles, saveStyleProfile, type SavedStyleProfile } from '../data/styleRepository';
import { createStyleProfile, type StyleProfileResult } from '../services/api';
import { persistStyleProfile } from '../services/sync';
import { useExposure } from '../state/ExposureContext';

export const LooksScreen = () => {
  const { photos, selectedPhoto, addLayer } = useExposure();
  const [selected, setSelected] = useState<string[]>([]);
  const [style, setStyle] = useState<StyleProfileResult>();
  const [savedStyles, setSavedStyles] = useState<SavedStyleProfile[]>([]);
  const [strength, setStrength] = useState(0.75);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => { void loadStyleProfiles().then(setSavedStyles); }, []);

  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length < 8 ? [...current, id] : current);
  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const created = await createStyleProfile(photos.filter((photo) => selected.includes(photo.id)));
      const saved = await saveStyleProfile(created, selected);
      setStyle(created);
      setSavedStyles((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      await persistStyleProfile(created, selected);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Look creation failed.');
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!style || !selectedPhoto) return;
    await addLayer({
      id: randomUUID(), type: 'style', name: style.name, enabled: true, opacity: 1,
      createdAt: new Date().toISOString(), styleProfileId: style.id, adjustments: style.adjustments, strength,
    }, `Look: ${style.name}`);
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.eyebrow}>STYLE LAB</Text><Text style={styles.title}>Looks</Text>
      <Text style={styles.intro}>Choose 3–8 inspiration frames. Exposure extracts their palette and tonal behavior into one reversible Style layer.</Text>
      {savedStyles.length ? <><Text style={styles.savedTitle}>SAVED LOOKS</Text><ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.savedRow}>{savedStyles.map((saved) => <Pressable key={saved.id} style={[styles.savedChip, style?.id === saved.id && styles.savedChipActive]} onPress={() => setStyle(saved)}><Text style={styles.savedChipText}>{saved.name}</Text></Pressable>)}</ScrollView></> : null}
      <View style={styles.grid}>
        {photos.map((photo) => {
          const chosen = selected.includes(photo.id);
          return <Pressable key={photo.id} onPress={() => toggle(photo.id)} style={[styles.tile, chosen && styles.chosen]}><Image source={{ uri: photo.thumbnailUri }} style={styles.image} /><Text style={styles.mark}>{chosen ? '✓' : '+'}</Text></Pressable>;
        })}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable style={[styles.primary, (selected.length < 3 || selected.length > 8) && styles.disabled]} disabled={selected.length < 3 || selected.length > 8 || busy} onPress={create}>
        {busy ? <ActivityIndicator color={colors.limeInk} /> : <Text style={styles.primaryText}>Extract look from {selected.length} references</Text>}
      </Pressable>
      {style ? <View style={styles.result}><Text style={styles.resultTitle}>{style.name}</Text><Text style={styles.mood}>{style.mood}</Text><View style={styles.palette}>{style.palette.map((color) => <View key={color} style={[styles.swatch, { backgroundColor: color }]} />)}</View><Text style={styles.adjustments}>{Object.entries(style.adjustments).map(([key, value]) => `${key} ${value}`).join(' · ')}</Text><Text style={styles.strengthLabel}>STRENGTH · {Math.round(strength * 100)}%</Text><View style={styles.strengthRow}>{[0.25, 0.5, 0.75, 1].map((value) => <Pressable key={value} style={[styles.strengthButton, strength === value && styles.strengthActive]} onPress={() => setStrength(value)}><Text style={[styles.strengthText, strength === value && styles.strengthTextActive]}>{Math.round(value * 100)}</Text></Pressable>)}</View><Pressable style={styles.apply} onPress={apply} disabled={!selectedPhoto}><Text style={styles.applyText}>Apply to current photo as a layer</Text></Pressable></View> : null}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas }, content: { padding: 20, paddingBottom: 48 },
  eyebrow: { color: colors.lime, fontWeight: '900', fontSize: 9, letterSpacing: 2.2, marginTop: 6 },
  title: { color: colors.ink, fontSize: 34, fontWeight: '900', marginTop: 5 }, intro: { color: colors.muted, fontSize: 13, lineHeight: 20, marginTop: 8 },
  savedTitle: { color: colors.muted, fontSize: 8, fontWeight: '900', letterSpacing: 1.4, marginTop: 18 }, savedRow: { gap: 7, paddingTop: 8 }, savedChip: { borderWidth: 1, borderColor: colors.line, paddingHorizontal: 11, paddingVertical: 8 }, savedChipActive: { borderColor: colors.lime }, savedChipText: { color: colors.ink, fontSize: 10, fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 20 }, tile: { width: '31%', aspectRatio: 1, borderWidth: 2, borderColor: 'transparent' }, chosen: { borderColor: colors.lime }, image: { width: '100%', height: '100%' },
  mark: { position: 'absolute', right: 5, top: 4, color: colors.ink, backgroundColor: 'rgba(0,0,0,0.7)', width: 22, height: 22, borderRadius: 11, textAlign: 'center', lineHeight: 22, fontWeight: '900' },
  primary: { minHeight: 48, marginTop: 18, backgroundColor: colors.lime, alignItems: 'center', justifyContent: 'center', borderRadius: 3 }, primaryText: { color: colors.limeInk, fontWeight: '900', fontSize: 12 }, disabled: { opacity: 0.35 }, error: { color: colors.danger, fontSize: 11, marginTop: 12 },
  result: { marginTop: 18, padding: 18, backgroundColor: colors.panel, borderWidth: 1, borderColor: colors.line }, resultTitle: { color: colors.ink, fontSize: 20, fontWeight: '900' }, mood: { color: colors.muted, fontSize: 12, marginTop: 4 }, palette: { flexDirection: 'row', height: 36, marginTop: 14 }, swatch: { flex: 1 }, adjustments: { color: colors.muted, fontSize: 10, lineHeight: 16, marginTop: 12 }, strengthLabel: { color: colors.muted, fontSize: 8, fontWeight: '900', letterSpacing: 1.2, marginTop: 12 }, strengthRow: { flexDirection: 'row', gap: 6, marginTop: 7 }, strengthButton: { flex: 1, borderWidth: 1, borderColor: colors.line, paddingVertical: 8, alignItems: 'center' }, strengthActive: { backgroundColor: colors.lime, borderColor: colors.lime }, strengthText: { color: colors.muted, fontSize: 9, fontWeight: '900' }, strengthTextActive: { color: colors.limeInk }, apply: { padding: 13, borderColor: colors.lime, borderWidth: 1, marginTop: 14, alignItems: 'center' }, applyText: { color: colors.lime, fontSize: 11, fontWeight: '900' },
});
