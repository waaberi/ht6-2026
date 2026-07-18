import { Ionicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import React, { useMemo, useState } from 'react';
import {
  AccessibilityInfo,
  Alert,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';

import { colors, layout, radii, spacing, typography } from '../components/theme';
import { ActionButton } from '../components/ui/ActionButton';
import { EmptyState } from '../components/ui/EmptyState';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { StickyActionBar } from '../components/ui/StickyActionBar';
import { saveStyleProfile } from '../data/styleRepository';
import type { PhotoRecord } from '../domain/types';
import {
  createStyleProfile,
  reviewPortfolio,
  type PortfolioReview,
  type StyleProfileResult,
} from '../services/api';
import { persistPortfolioReview, persistStyleProfile } from '../services/sync';
import { useExposure } from '../state/ExposureContext';

type LibraryMode = 'photos' | 'portfolio' | 'looks';

type LibraryScreenProps = {
  onOpenStudio: () => void;
  onOpenCamera?: () => void;
};

const modes: Array<{ id: LibraryMode; label: string }> = [
  { id: 'photos', label: 'Photos' },
  { id: 'portfolio', label: 'Portfolio' },
  { id: 'looks', label: 'Looks' },
];

export const LibraryScreen = ({ onOpenStudio, onOpenCamera }: LibraryScreenProps) => {
  const { width } = useWindowDimensions();
  const { photos, selectPhoto, syncing, syncError, ingest } = useExposure();
  const [mode, setMode] = useState<LibraryMode>('photos');
  const [portfolioSelection, setPortfolioSelection] = useState<string[]>([]);
  const [lookSelection, setLookSelection] = useState<string[]>([]);
  const [portfolioReview, setPortfolioReview] = useState<PortfolioReview>();
  const [activeStyle, setActiveStyle] = useState<StyleProfileResult>();
  const [busy, setBusy] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const columnCount = width >= 900 ? 6 : width >= 600 ? 4 : 3;
  const photoById = useMemo(() => new Map(photos.map((photo) => [photo.id, photo])), [photos]);

  const open = (photo: PhotoRecord) => {
    selectPhoto(photo.id);
    onOpenStudio();
  };

  const runImport = async (work: () => Promise<void>) => {
    if (importing) return;
    setImporting(true);
    try {
      await work();
    } catch (caught) {
      Alert.alert('Import failed', caught instanceof Error ? caught.message : 'The photo could not be imported.');
    } finally {
      setImporting(false);
    }
  };

  const importPhoto = () => void runImport(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: 'images',
      allowsMultipleSelection: false,
      quality: 1,
      exif: true,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    await ingest({
      uri: asset.uri,
      name: asset.fileName ?? `Imported-${Date.now()}.jpg`,
      mimeType: asset.mimeType,
      source: 'library',
      width: asset.width,
      height: asset.height,
      exif: asset.exif,
    });
  });

  const importFile = () => void runImport(async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: ['image/jpeg', 'image/png', 'image/heic', 'image/heif'],
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    const documentUri = decodeURIComponent(asset.uri);
    const removableStorage = /externalstorage\.documents.*\/document\/(?!primary:)/i.test(documentUri);
    await ingest({
      uri: asset.uri,
      name: asset.name,
      mimeType: asset.mimeType,
      source: removableStorage ? 'usb' : 'document',
    });
  });

  const showImportMenu = () => Alert.alert('Import', undefined, [
    { text: 'Photo library', onPress: importPhoto },
    { text: 'Files or USB', onPress: importFile },
    { text: 'Cancel', style: 'cancel' },
  ]);

  const changeMode = (nextMode: LibraryMode) => {
    setMode(nextMode);
    setError(undefined);
    setNotice(undefined);
  };

  const togglePortfolio = (id: string) => {
    setPortfolioReview(undefined);
    setNotice(undefined);
    setPortfolioSelection((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length < 20) return [...current, id];
      const message = 'Maximum 20 photos.';
      setNotice(message);
      AccessibilityInfo.announceForAccessibility(message);
      return current;
    });
  };

  const toggleLook = (id: string) => {
    setActiveStyle(undefined);
    setNotice(undefined);
    setLookSelection((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length < 8) return [...current, id];
      const message = 'Maximum 8 references.';
      setNotice(message);
      AccessibilityInfo.announceForAccessibility(message);
      return current;
    });
  };

  const runPortfolioReview = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await reviewPortfolio(photos.filter((photo) => portfolioSelection.includes(photo.id)));
      setPortfolioReview(result);
      await persistPortfolioReview(result, portfolioSelection);
      AccessibilityInfo.announceForAccessibility('Portfolio review ready.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Portfolio review failed.');
    } finally {
      setBusy(false);
    }
  };

  const createLook = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const created = await createStyleProfile(photos.filter((photo) => lookSelection.includes(photo.id)));
      await saveStyleProfile(created, lookSelection);
      setActiveStyle(created);
      await persistStyleProfile(created, lookSelection);
      AccessibilityInfo.announceForAccessibility(`${created.name} is ready.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Look creation failed.');
    } finally {
      setBusy(false);
    }
  };

  const headerDetail = mode === 'photos'
    ? syncing ? 'Syncing…' : syncError ? 'Sync issue' : undefined
    : mode === 'portfolio'
      ? `${portfolioSelection.length}/20`
      : `${lookSelection.length}/8`;

  const selection = mode === 'portfolio' ? portfolioSelection : lookSelection;
  const hasSelectionSurface = mode === 'portfolio' ? !portfolioReview : mode === 'looks' ? !activeStyle : false;

  return (
    <View style={styles.screen}>
      <ScreenHeader
        title="Library"
        detail={headerDetail}
        action={photos.length ? { label: 'Import photo', icon: 'add', onPress: showImportMenu, busy: importing } : undefined}
      />
      {photos.length ? <LibraryModeTabs active={mode} onChange={changeMode} /> : null}

      {photos.length === 0 ? (
        <EmptyState icon="images-outline" title="No photos yet">
          {onOpenCamera ? <ActionButton label="Take a photo" icon="camera-outline" onPress={onOpenCamera} /> : null}
          <ActionButton label="Import" icon="download-outline" variant="outlined" onPress={showImportMenu} />
        </EmptyState>
      ) : mode === 'portfolio' && portfolioReview ? (
        <PortfolioResult
          review={portfolioReview}
          photoById={photoById}
          onReset={() => {
            setPortfolioReview(undefined);
            setPortfolioSelection([]);
          }}
        />
      ) : mode === 'looks' && activeStyle ? (
        <LookResult
          style={activeStyle}
          onUse={() => {
            setActiveStyle(undefined);
            setLookSelection([]);
            setError(undefined);
            setMode('photos');
          }}
          onReset={() => {
            setActiveStyle(undefined);
            setLookSelection([]);
            setError(undefined);
          }}
        />
      ) : (
        <View style={styles.browser}>
          {mode !== 'photos' ? (
            <View style={styles.selectionHeader}>
              <Text style={styles.instruction}>
                {mode === 'portfolio' ? 'Choose 2–20 photos' : 'Choose 3–8 references'}
              </Text>
              {selection.length ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Clear selection"
                  onPress={() => mode === 'portfolio' ? setPortfolioSelection([]) : setLookSelection([])}
                  style={({ pressed }) => [styles.clearButton, pressed && styles.pressed]}
                >
                  <Text style={styles.clearLabel}>Clear</Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
          {notice ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text> : null}
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
          <FlashList
            key={`library-${mode}-${columnCount}`}
            data={photos}
            extraData={selection}
            numColumns={columnCount}
            contentContainerStyle={[styles.grid, mode !== 'photos' && styles.selectionGrid]}
            keyExtractor={(item) => item.id}
            renderItem={({ item }) => (
              <PhotoTile
                photo={item}
                selected={selection.includes(item.id)}
                order={mode === 'portfolio' ? selection.indexOf(item.id) + 1 : undefined}
                selectionMode={mode !== 'photos'}
                onPress={() => mode === 'photos' ? open(item) : mode === 'portfolio' ? togglePortfolio(item.id) : toggleLook(item.id)}
              />
            )}
          />
        </View>
      )}

      {photos.length && hasSelectionSurface ? (
        <StickyActionBar>
          <ActionButton
            label={mode === 'portfolio' ? 'Review portfolio' : 'Create look'}
            onPress={() => mode === 'portfolio' ? void runPortfolioReview() : void createLook()}
            disabled={mode === 'portfolio' ? portfolioSelection.length < 2 : lookSelection.length < 3}
            loading={busy}
          />
        </StickyActionBar>
      ) : null}
    </View>
  );
};

const LibraryModeTabs = ({ active, onChange }: { active: LibraryMode; onChange: (mode: LibraryMode) => void }) => (
  <View accessibilityRole="tablist" style={styles.modeTabs}>
    {modes.map((mode) => {
      const selected = mode.id === active;
      return (
        <Pressable
          key={mode.id}
          accessibilityRole="tab"
          accessibilityState={{ selected }}
          onPress={() => onChange(mode.id)}
          style={({ pressed }) => [styles.modeTab, selected && styles.modeTabSelected, pressed && styles.pressed]}
        >
          <Text style={[styles.modeLabel, selected && styles.modeLabelSelected]}>{mode.label}</Text>
        </Pressable>
      );
    })}
  </View>
);

const PhotoTile = ({ photo, selected, order, selectionMode, onPress }: {
  photo: PhotoRecord;
  selected: boolean;
  order?: number;
  selectionMode: boolean;
  onPress: () => void;
}) => (
  <Pressable
    accessibilityRole={selectionMode ? 'checkbox' : 'button'}
    accessibilityLabel={photo.originalName}
    accessibilityHint={selectionMode ? selected ? 'Removes from selection' : 'Adds to selection' : 'Opens photo editor'}
    accessibilityState={selectionMode ? { checked: selected } : undefined}
    onPress={onPress}
    style={({ pressed }) => [styles.tile, selected && styles.selectedTile, pressed && styles.tilePressed]}
  >
    <Image source={{ uri: photo.thumbnailUri }} style={styles.image} resizeMode="cover" accessible={false} />
    {selectionMode ? (
      <View style={[styles.selectionBadge, selected && styles.selectionBadgeSelected]} accessibilityElementsHidden>
        {selected && order ? (
          <Text style={styles.order}>{order}</Text>
        ) : selected ? (
          <Ionicons name="checkmark" size={18} color={colors.onPrimary} />
        ) : null}
      </View>
    ) : photo.syncState !== 'synced' ? (
      <View style={styles.syncBadge} accessibilityElementsHidden>
        <Ionicons name="cloud-upload-outline" size={16} color={colors.text} />
      </View>
    ) : null}
  </Pressable>
);

const PortfolioResult = ({ review, photoById, onReset }: {
  review: PortfolioReview;
  photoById: Map<string, PhotoRecord>;
  onReset: () => void;
}) => (
  <ScrollView contentContainerStyle={styles.resultContent}>
    <Text accessibilityRole="header" style={styles.resultTitle}>Recommended order</Text>
    {review.summary ? <Text style={styles.resultSummary}>{review.summary}</Text> : null}
    <View style={styles.ranking}>
      {review.orderedPhotoIds.map((id, index) => {
        const photo = photoById.get(id);
        if (!photo) return null;
        return (
          <View key={id} style={styles.rankRow}>
            <Text style={styles.rankNumber}>{index + 1}</Text>
            <Image source={{ uri: photo.thumbnailUri }} style={styles.rankImage} accessible={false} />
            <Text style={styles.rankText}>{review.explanations[id] ?? photo.originalName}</Text>
          </View>
        );
      })}
    </View>
    <ActionButton label="Review another set" variant="outlined" onPress={onReset} />
  </ScrollView>
);

const LookResult = ({
  style,
  onUse,
  onReset,
}: {
  style: StyleProfileResult;
  onUse: () => void;
  onReset: () => void;
}) => (
  <ScrollView contentContainerStyle={styles.resultContent}>
    <Text accessibilityRole="header" style={styles.resultTitle}>{style.name}</Text>
    {style.mood ? <Text style={styles.resultSummary}>{style.mood}</Text> : null}
    <View style={styles.palette} accessibilityLabel={`${style.name} color palette`}>
      {style.palette.map((color, index) => (
        <View key={`${color}-${index}`} style={[styles.swatch, { backgroundColor: color }]} />
      ))}
    </View>
    <View style={styles.resultActions}>
      <ActionButton label="Choose a photo" onPress={onUse} />
      <ActionButton label="Choose other photos" variant="outlined" onPress={onReset} />
    </View>
  </ScrollView>
);

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  browser: { flex: 1 },
  modeTabs: {
    minHeight: layout.minTouchTarget,
    flexDirection: 'row',
    marginHorizontal: layout.screenPadding,
    marginBottom: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.outline,
  },
  modeTab: {
    flex: 1,
    minHeight: layout.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  modeTabSelected: { borderBottomColor: colors.text },
  modeLabel: { color: colors.textSecondary, ...typography.label, fontWeight: '600' },
  modeLabelSelected: { color: colors.text, fontWeight: '700' },
  selectionHeader: {
    minHeight: layout.minTouchTarget,
    paddingLeft: layout.screenPadding,
    paddingRight: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  instruction: { color: colors.textSecondary, ...typography.label },
  clearButton: {
    minWidth: layout.minTouchTarget,
    minHeight: layout.minTouchTarget,
    paddingHorizontal: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearLabel: { color: colors.text, ...typography.label, fontWeight: '700' },
  notice: {
    color: colors.text,
    ...typography.label,
    marginHorizontal: layout.screenPadding,
    marginBottom: spacing.sm,
  },
  error: {
    color: colors.danger,
    ...typography.label,
    marginBottom: spacing.sm,
  },
  grid: { paddingHorizontal: spacing.xxs, paddingBottom: spacing.md },
  selectionGrid: { paddingBottom: layout.stickyActionHeight + spacing.md },
  tile: {
    flex: 1,
    aspectRatio: 0.9,
    margin: 2,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    overflow: 'hidden',
  },
  selectedTile: { borderColor: colors.text },
  tilePressed: { opacity: 0.78 },
  pressed: { opacity: 0.72 },
  image: { width: '100%', height: '100%' },
  syncBadge: {
    position: 'absolute',
    right: spacing.xs,
    bottom: spacing.xs,
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.overlay,
  },
  selectionBadge: {
    position: 'absolute',
    top: spacing.xs,
    right: spacing.xs,
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1,
    borderColor: colors.text,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectionBadgeSelected: { backgroundColor: colors.text, borderColor: colors.text },
  order: { color: colors.onPrimary, ...typography.label, fontWeight: '800' },
  savedSection: { marginBottom: spacing.sm },
  sectionLabel: {
    color: colors.text,
    ...typography.label,
    fontWeight: '700',
    marginHorizontal: layout.screenPadding,
    marginBottom: spacing.sm,
  },
  savedRow: { gap: spacing.sm, paddingHorizontal: layout.screenPadding },
  savedLook: {
    width: 124,
    minHeight: 64,
    padding: spacing.sm,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
  },
  savedPalette: { height: 22, flexDirection: 'row', borderRadius: 4, overflow: 'hidden' },
  savedSwatch: { flex: 1 },
  savedName: { color: colors.text, ...typography.caption, fontWeight: '700', marginTop: spacing.xs },
  resultContent: {
    paddingHorizontal: layout.screenPadding,
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  resultTitle: { color: colors.text, ...typography.title, fontWeight: '700' },
  resultSummary: { color: colors.textSecondary, ...typography.body, marginTop: spacing.xs },
  ranking: { marginTop: spacing.lg, marginBottom: spacing.lg },
  rankRow: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.base,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.outline,
  },
  rankNumber: { width: 24, color: colors.text, ...typography.section, fontWeight: '800', textAlign: 'center' },
  rankImage: { width: 52, height: 52, borderRadius: radii.sm, backgroundColor: colors.surface },
  rankText: { flex: 1, color: colors.text, ...typography.label },
  palette: { height: 48, flexDirection: 'row', marginTop: spacing.lg, borderRadius: radii.sm, overflow: 'hidden' },
  swatch: { flex: 1 },
  strengthHeader: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.lg },
  strengthLabel: { color: colors.text, ...typography.label, fontWeight: '700' },
  strengthValue: { color: colors.textSecondary, ...typography.label },
  slider: { width: '100%', height: 48, marginTop: spacing.xxs },
  target: { color: colors.textSecondary, ...typography.caption, marginTop: spacing.sm, marginBottom: spacing.md },
  resultActions: { gap: spacing.sm, marginTop: spacing.sm },
});
