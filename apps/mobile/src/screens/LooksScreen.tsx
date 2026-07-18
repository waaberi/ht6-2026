import { FlashList } from '@shopify/flash-list';
import Slider from '@react-native-community/slider';
import { randomUUID } from 'expo-crypto';
import React, { useEffect, useState } from 'react';
import { AccessibilityInfo, FlatList, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { colors, layout, radii, spacing, typography } from '../components/theme';
import { ActionButton } from '../components/ui/ActionButton';
import { EmptyState } from '../components/ui/EmptyState';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { SelectablePhotoTile } from '../components/ui/SelectablePhotoTile';
import { StickyActionBar } from '../components/ui/StickyActionBar';
import { loadStyleProfiles, saveStyleProfile, type SavedStyleProfile } from '../data/styleRepository';
import { createStyleProfile, type StyleProfileResult } from '../services/api';
import { persistStyleProfile } from '../services/sync';
import { useExposure } from '../state/ExposureContext';

export const LooksScreen = () => {
  const { width } = useWindowDimensions();
  const { photos, selectedPhoto, addLayer } = useExposure();
  const [selected, setSelected] = useState<string[]>([]);
  const [style, setStyle] = useState<StyleProfileResult>();
  const [savedStyles, setSavedStyles] = useState<SavedStyleProfile[]>([]);
  const [strength, setStrength] = useState(0.75);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const columnCount = width >= 900 ? 7 : width >= 600 ? 5 : 3;

  useEffect(() => { void loadStyleProfiles().then(setSavedStyles); }, []);

  const toggle = (id: string) => {
    setStyle(undefined);
    setNotice(undefined);
    setSelected((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length < 8) return [...current, id];
      const message = 'You can select up to 8 references.';
      setNotice(message);
      AccessibilityInfo.announceForAccessibility(message);
      return current;
    });
  };

  const create = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const created = await createStyleProfile(photos.filter((photo) => selected.includes(photo.id)));
      const saved = await saveStyleProfile(created, selected);
      setStyle(created);
      setSavedStyles((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      await persistStyleProfile(created, selected);
      AccessibilityInfo.announceForAccessibility(`${created.name} is ready.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Look creation failed.');
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!style || !selectedPhoto) return;
    setBusy(true);
    setError(undefined);
    try {
      await addLayer({
        id: randomUUID(),
        type: 'style',
        name: style.name,
        enabled: true,
        opacity: 1,
        createdAt: new Date().toISOString(),
        styleProfileId: style.id,
        adjustments: style.adjustments,
        strength,
      }, `Look: ${style.name}`);
      AccessibilityInfo.announceForAccessibility(`${style.name} applied.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Look could not be applied.');
    } finally {
      setBusy(false);
    }
  };

  const chooseSavedStyle = (saved: SavedStyleProfile) => {
    setStyle(saved);
    setStrength(0.75);
    setError(undefined);
  };

  const savedLooks = savedStyles.length ? (
    <View style={styles.savedSection}>
      <Text style={styles.sectionTitle}>Saved</Text>
      <FlatList
        horizontal
        data={savedStyles}
        keyExtractor={(item) => item.id}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.savedRow}
        renderItem={({ item }) => {
          const active = style?.id === item.id;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={item.name}
              accessibilityState={{ selected: active }}
              onPress={() => chooseSavedStyle(item)}
              style={({ pressed }) => [styles.savedLook, active && styles.savedLookActive, pressed && styles.pressed]}
            >
              <View style={styles.savedPalette} accessibilityElementsHidden>
                {item.palette.slice(0, 4).map((color, index) => (
                  <View key={`${color}-${index}`} style={[styles.savedSwatch, { backgroundColor: color }]} />
                ))}
              </View>
              <Text numberOfLines={1} style={styles.savedName}>{item.name}</Text>
            </Pressable>
          );
        }}
      />
    </View>
  ) : null;

  const listHeader = (
    <>
      <ScreenHeader title="Looks" detail={`${selected.length}/8`} />
      {savedLooks}
      <Text style={styles.instruction}>Select 3–8 reference photos</Text>
      {notice ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </>
  );

  const result = style ? (
    <View style={styles.result} accessibilityLiveRegion="polite">
      <Text accessibilityRole="header" style={styles.resultTitle}>{style.name}</Text>
      {style.mood ? <Text style={styles.mood}>{style.mood}</Text> : null}
      <View style={styles.palette} accessibilityLabel={`${style.name} color palette`}>
        {style.palette.map((color, index) => <View key={`${color}-${index}`} style={[styles.swatch, { backgroundColor: color }]} />)}
      </View>
      <View style={styles.strengthHeader}>
        <Text style={styles.strengthLabel}>Strength</Text>
        <Text style={styles.strengthValue}>{Math.round(strength * 100)}%</Text>
      </View>
      <Slider
        accessibilityLabel="Look strength"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(strength * 100), text: `${Math.round(strength * 100)} percent` }}
        style={styles.slider}
        minimumValue={0}
        maximumValue={1}
        step={0.01}
        value={strength}
        onValueChange={setStrength}
        minimumTrackTintColor={colors.primary}
        maximumTrackTintColor={colors.outlineStrong}
        thumbTintColor={colors.text}
      />
      {!selectedPhoto ? <Text style={styles.targetNotice}>Choose a photo in Library before applying.</Text> : null}
    </View>
  ) : <View style={styles.footerSpacer} />;

  return (
    <View style={styles.screen}>
      {photos.length === 0 ? (
        <>
          <ScreenHeader title="Looks" detail="0/8" />
          {savedLooks}
          <EmptyState icon="color-palette-outline" title="No reference photos" />
        </>
      ) : (
        <FlashList
          key={`looks-${columnCount}`}
          data={photos}
          extraData={selected}
          numColumns={columnCount}
          contentContainerStyle={styles.content}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={listHeader}
          ListFooterComponent={result}
          renderItem={({ item }) => (
            <SelectablePhotoTile
              photo={item}
              selected={selected.includes(item.id)}
              onPress={() => toggle(item.id)}
              aspectRatio={1}
            />
          )}
        />
      )}
      {(photos.length || style) ? (
        <StickyActionBar>
          {style ? (
            <ActionButton label={`Apply ${style.name}`} onPress={apply} disabled={!selectedPhoto} loading={busy} />
          ) : (
            <ActionButton
              label={selected.length >= 3 ? 'Create look' : 'Select at least 3 references'}
              onPress={create}
              disabled={selected.length < 3 || selected.length > 8}
              loading={busy}
            />
          )}
        </StickyActionBar>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: spacing.xxs, paddingBottom: layout.stickyActionHeight + spacing.md },
  instruction: {
    color: colors.textSecondary,
    ...typography.label,
    marginHorizontal: layout.screenPadding,
    marginBottom: spacing.base,
  },
  notice: {
    color: colors.text,
    ...typography.label,
    marginHorizontal: layout.screenPadding,
    marginBottom: spacing.base,
  },
  error: {
    color: colors.danger,
    ...typography.label,
    marginHorizontal: layout.screenPadding,
    marginBottom: spacing.base,
  },
  sectionTitle: { color: colors.text, ...typography.section, fontWeight: '700', marginHorizontal: layout.screenPadding },
  savedSection: { marginBottom: spacing.lg },
  savedRow: { gap: spacing.sm, paddingHorizontal: layout.screenPadding, paddingTop: spacing.sm },
  savedLook: {
    width: 132,
    minHeight: 72,
    padding: spacing.sm,
    borderWidth: 1,
    borderColor: colors.outline,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  savedLookActive: { borderColor: colors.text },
  savedPalette: { height: 26, flexDirection: 'row', borderRadius: radii.sm, overflow: 'hidden' },
  savedSwatch: { flex: 1 },
  savedName: { color: colors.text, ...typography.caption, fontWeight: '700', marginTop: spacing.xs },
  pressed: { opacity: 0.8 },
  result: {
    marginHorizontal: spacing.md,
    marginTop: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.surface,
  },
  resultTitle: { color: colors.text, fontFamily: typography.displayFamily, ...typography.title },
  mood: { color: colors.textSecondary, ...typography.body, marginTop: spacing.xxs },
  palette: { height: 40, flexDirection: 'row', marginTop: spacing.md, borderRadius: radii.sm, overflow: 'hidden' },
  swatch: { flex: 1 },
  strengthHeader: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.lg },
  strengthLabel: { color: colors.text, ...typography.label, fontWeight: '700' },
  strengthValue: { color: colors.textSecondary, ...typography.label },
  slider: { width: '100%', height: 48, marginTop: spacing.xxs },
  targetNotice: { color: colors.textSecondary, ...typography.caption, marginTop: spacing.xs },
  footerSpacer: { height: spacing.md },
});
