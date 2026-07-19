import { Ionicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import React, { useMemo, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { EditedPhotoThumbnail } from '../components/EditedPhotoThumbnail';
import { colors, layout, radii, spacing, typography } from '../components/theme';
import { ActionButton } from '../components/ui/ActionButton';
import { EmptyState } from '../components/ui/EmptyState';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { StickyActionBar } from '../components/ui/StickyActionBar';
import { resolveCanvasExpansion, visibleRotatedCanvasSize } from '../domain/canvasTransforms';
import { currentVersion } from '../domain/layers';
import type { PhotoRecord } from '../domain/types';
import {
  reviewPortfolio,
  type PortfolioReview,
} from '../services/api';
import { persistPortfolioReview } from '../services/sync';
import { useExposure } from '../state/ExposureContext';

type LibraryView = 'browse' | 'select' | 'portfolio-result';
const PORTFOLIO_INK = '#181714';
const PORTFOLIO_PAPER = '#F4F0E7';

const portfolioAspectFor = (photo: PhotoRecord) => {
  const transform = currentVersion(photo).stack.canvasTransform;
  const canvas = visibleRotatedCanvasSize(photo.width, photo.height, transform.rotationDegrees);
  const crop = transform.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const contentWidth = canvas.width * crop.width;
  const contentHeight = canvas.height * crop.height;
  const expansion = resolveCanvasExpansion(transform.expansion, contentWidth, contentHeight);
  const aspect = (contentWidth + expansion.left + expansion.right)
    / Math.max(1, contentHeight + expansion.top + expansion.bottom);
  return Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
};

type LibraryScreenProps = {
  onOpenStudio: () => void;
  onOpenCamera?: () => void;
};

export const LibraryScreen = ({ onOpenStudio, onOpenCamera }: LibraryScreenProps) => {
  const { width } = useWindowDimensions();
  const { photos, selectPhoto, syncing, syncError, ingest, deletePhotos } = useExposure();
  const [view, setView] = useState<LibraryView>('browse');
  const [selection, setSelection] = useState<string[]>([]);
  const [portfolioReview, setPortfolioReview] = useState<PortfolioReview>();
  const [busy, setBusy] = useState<'portfolio' | 'delete'>();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const columnCount = width >= 900 ? 6 : width >= 600 ? 4 : 3;
  const photoById = useMemo(() => new Map(photos.map((photo) => [photo.id, photo])), [photos]);
  const photoRows = useMemo(() => {
    const rows: PhotoRecord[][] = [];
    for (let index = 0; index < photos.length; index += columnCount) {
      rows.push(photos.slice(index, index + columnCount));
    }
    return rows;
  }, [columnCount, photos]);

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

  const enterSelection = () => {
    setView('select');
    setSelection([]);
    setError(undefined);
    setNotice(undefined);
  };

  const leaveSelection = () => {
    setView('browse');
    setSelection([]);
    setPortfolioReview(undefined);
    setError(undefined);
    setNotice(undefined);
  };

  const toggleSelection = (id: string) => {
    setSelection((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length < 20) return [...current, id];
      const message = 'Maximum 20 photos.';
      setNotice(message);
      AccessibilityInfo.announceForAccessibility(message);
      return current;
    });
  };

  const runPortfolioReview = async () => {
    setBusy('portfolio');
    setError(undefined);
    try {
      const result = await reviewPortfolio(photos.filter((photo) => selection.includes(photo.id)));
      setPortfolioReview(result);
      setView('portfolio-result');
      await persistPortfolioReview(result, selection);
      AccessibilityInfo.announceForAccessibility('Portfolio review ready.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Portfolio review failed.');
    } finally {
      setBusy(undefined);
    }
  };

  const confirmDelete = () => {
    if (selection.length === 0 || busy) return;
    const count = selection.length;
    Alert.alert(`Delete ${count === 1 ? 'photo' : `${count} photos`}?`, undefined, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => void (async () => {
          setBusy('delete');
          setError(undefined);
          try {
            await deletePhotos(selection);
            leaveSelection();
          } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Photos could not be deleted.');
          } finally {
            setBusy(undefined);
          }
        })(),
      },
    ]);
  };

  const headerDetail = view === 'select'
    ? String(selection.length)
    : view === 'browse'
      ? syncing ? 'Syncing…' : syncError ? 'Sync issue' : undefined
      : undefined;

  return (
    <View style={styles.screen}>
      <ScreenHeader
        title={view === 'select'
          ? 'Select'
          : view === 'portfolio-result'
            ? 'Curate'
            : 'Library'}
        detail={headerDetail}
        actions={photos.length ? view === 'select' ? [
          { label: 'Cancel selection', icon: 'close', onPress: leaveSelection },
        ] : view === 'portfolio-result' ? [
          { label: 'Close result', icon: 'close', onPress: leaveSelection },
        ] : [
          { label: 'Select photos', icon: 'checkmark-circle-outline', onPress: enterSelection },
        ] : undefined}
      />

      {photos.length === 0 ? (
        <EmptyState icon="images-outline" title="No photos yet">
          {onOpenCamera ? <ActionButton label="Take a photo" icon="camera-outline" onPress={onOpenCamera} /> : null}
          <ActionButton label="Import" icon="download-outline" variant="tonal" onPress={showImportMenu} />
        </EmptyState>
      ) : view === 'portfolio-result' && portfolioReview ? (
        <PortfolioResult
          review={portfolioReview}
          photoById={photoById}
          onReset={() => {
            setPortfolioReview(undefined);
            setSelection([]);
            setView('select');
          }}
        />
      ) : (
        <View style={styles.browser}>
          {notice ? <Text accessibilityLiveRegion="polite" numberOfLines={2} style={styles.notice}>{notice}</Text> : null}
          {error ? <Text accessibilityRole="alert" numberOfLines={3} style={styles.error}>{error}</Text> : null}
          <FlashList
            key={`library-${view}-${columnCount}`}
            data={photoRows}
            extraData={selection}
            contentContainerStyle={[styles.grid, view === 'select' && styles.selectionGrid, view === 'browse' && styles.browseGrid]}
            keyExtractor={(row) => row.map((photo) => photo.id).join(':')}
            renderItem={({ item: row }) => {
              const spacerWeight = (columnCount - row.length) / 2;
              return (
                <View style={styles.gridRow}>
                  {spacerWeight > 0 ? <View style={{ flex: spacerWeight }} /> : null}
                  {row.map((item) => (
                    <View key={item.id} style={styles.gridCell}>
                      <PhotoTile
                        photo={item}
                        selected={selection.includes(item.id)}
                        order={view === 'select' ? selection.indexOf(item.id) + 1 : undefined}
                        selectionMode={view === 'select'}
                        onPress={() => view === 'select' ? toggleSelection(item.id) : open(item)}
                      />
                    </View>
                  ))}
                  {spacerWeight > 0 ? <View style={{ flex: spacerWeight }} /> : null}
                </View>
              );
            }}
          />
        </View>
      )}

      {photos.length > 0 && view === 'browse' ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Import photo"
          accessibilityState={{ disabled: importing, busy: importing }}
          disabled={importing}
          onPress={showImportMenu}
          style={({ pressed }) => [styles.importFab, pressed && styles.primaryPressed, importing && styles.disabled]}
        >
          {importing ? <ActivityIndicator color={colors.onPrimary} /> : <Ionicons name="add" size={28} color={colors.onPrimary} />}
        </Pressable>
      ) : null}

      {photos.length > 0 && view === 'select' ? (
        <StickyActionBar>
          <View style={styles.taskActions}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Delete selected photos"
              accessibilityState={{ disabled: selection.length === 0 || Boolean(busy), busy: busy === 'delete' }}
              disabled={selection.length === 0 || Boolean(busy)}
              onPress={confirmDelete}
              style={({ pressed }) => [styles.deleteAction, pressed && styles.controlPressed, (selection.length === 0 || busy) && styles.disabled]}
            >
              <Ionicons name="trash-outline" size={22} color={colors.danger} />
            </Pressable>
            <ActionButton label="Curate set" accessibilityHint="Select at least two photos" style={styles.taskAction} onPress={() => void runPortfolioReview()} disabled={selection.length < 2 || Boolean(busy)} loading={busy === 'portfolio'} />
          </View>
        </StickyActionBar>
      ) : null}
    </View>
  );
};

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
    <EditedPhotoThumbnail photo={photo} style={styles.image} />
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
}) => {
  const [previewOpen, setPreviewOpen] = useState(false);
  const orderedPhotos = review.orderedPhotoIds
    .map((id) => photoById.get(id))
    .filter((photo): photo is PhotoRecord => Boolean(photo));
  return (
    <>
      <ScrollView contentContainerStyle={styles.resultContent}>
        <Text accessibilityRole="header" style={styles.resultTitle}>Recommended order</Text>
        {review.summary ? <Text style={styles.resultSummary}>{review.summary}</Text> : null}
        <View style={styles.ranking}>
          {orderedPhotos.map((photo, index) => (
            <View key={photo.id} style={styles.rankRow}>
              <Text style={styles.rankNumber}>{index + 1}</Text>
              <EditedPhotoThumbnail photo={photo} style={styles.rankImage} />
              <Text style={styles.rankText}>{review.explanations[photo.id] ?? photo.originalName}</Text>
            </View>
          ))}
        </View>
        <View style={styles.resultActions}>
          <ActionButton label="Preview portfolio" icon="eye-outline" onPress={() => setPreviewOpen(true)} />
          <ActionButton label="Curate another set" variant="outlined" onPress={onReset} />
        </View>
      </ScrollView>
      <PortfolioPreview
        photos={orderedPhotos}
        visible={previewOpen}
        onClose={() => setPreviewOpen(false)}
      />
    </>
  );
};

const PortfolioPreview = ({
  photos,
  visible,
  onClose,
}: {
  photos: PhotoRecord[];
  visible: boolean;
  onClose: () => void;
}) => {
  const { height } = useWindowDimensions();
  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      presentationStyle="fullScreen"
      statusBarTranslucent
      visible={visible}
    >
      <View style={styles.portfolioPreview}>
        <FlashList
          data={photos}
          keyExtractor={(photo) => photo.id}
          ListHeaderComponent={(
            <View style={[styles.portfolioHero, { height }]}>
              <Text accessibilityRole="header" style={styles.portfolioHeroTitle}>photography portfolio</Text>
              <View style={styles.portfolioScrollCue}>
                <Text style={styles.portfolioScrollText}>scroll to view</Text>
                <Ionicons color={PORTFOLIO_INK} name="arrow-down" size={17} />
              </View>
            </View>
          )}
          ListFooterComponent={(
            <SafeAreaView edges={['bottom']} style={styles.portfolioFooter}>
              <Text style={styles.portfolioFooterText}>selected work</Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Exit portfolio preview"
                onPress={onClose}
                style={({ pressed }) => [styles.portfolioExit, pressed && styles.portfolioExitPressed]}
              >
                <Text style={styles.portfolioExitText}>Exit preview</Text>
                <Ionicons color={PORTFOLIO_PAPER} name="close" size={19} />
              </Pressable>
            </SafeAreaView>
          )}
          renderItem={({ item: photo, index }) => {
            return (
              <View style={styles.portfolioPhotoBlock}>
                <Text style={styles.portfolioIndex}>{String(index + 1).padStart(2, '0')}</Text>
                <EditedPhotoThumbnail
                  photo={photo}
                  style={[styles.portfolioPhoto, { aspectRatio: portfolioAspectFor(photo) }]}
                />
              </View>
            );
          }}
          showsVerticalScrollIndicator={false}
          style={styles.portfolioList}
        />
        <SafeAreaView edges={['top']} pointerEvents="box-none" style={styles.portfolioControls}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close portfolio preview"
            onPress={onClose}
            style={({ pressed }) => [styles.portfolioClose, pressed && styles.portfolioClosePressed]}
          >
            <Ionicons color={PORTFOLIO_PAPER} name="close" size={24} />
          </Pressable>
        </SafeAreaView>
      </View>
    </Modal>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  browser: { flex: 1 },
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
  gridRow: { flexDirection: 'row' },
  gridCell: { flex: 1, padding: 2 },
  browseGrid: { paddingBottom: layout.stickyActionHeight + spacing.md },
  selectionGrid: { paddingBottom: layout.stickyActionHeight + spacing.md },
  tile: {
    width: '100%',
    aspectRatio: 0.9,
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: colors.surface,
    borderRadius: radii.sm,
    overflow: 'hidden',
  },
  selectedTile: { borderColor: colors.primary },
  tilePressed: { borderColor: colors.outlineStrong },
  primaryPressed: { backgroundColor: colors.primaryPressed },
  controlPressed: { backgroundColor: colors.controlPressed },
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
  selectionBadgeSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  order: { color: colors.onPrimary, ...typography.label, fontWeight: '800' },
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
    borderBottomColor: colors.separator,
  },
  rankNumber: { width: 24, color: colors.text, ...typography.section, fontWeight: '800', textAlign: 'center' },
  rankImage: { width: 52, height: 52, borderRadius: radii.sm, backgroundColor: colors.surface },
  rankText: { flex: 1, color: colors.text, ...typography.label },
  resultActions: { gap: spacing.sm },
  portfolioPreview: { flex: 1, backgroundColor: PORTFOLIO_PAPER },
  portfolioList: { flex: 1 },
  portfolioHero: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.xl, backgroundColor: PORTFOLIO_PAPER },
  portfolioHeroTitle: { maxWidth: 720, color: PORTFOLIO_INK, fontSize: 48, lineHeight: 56, fontWeight: '300', letterSpacing: -1.8, textAlign: 'center', textTransform: 'lowercase' },
  portfolioScrollCue: { position: 'absolute', bottom: spacing.xl, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  portfolioScrollText: { color: PORTFOLIO_INK, ...typography.caption, letterSpacing: 1.2, textTransform: 'uppercase' },
  portfolioPhotoBlock: { paddingHorizontal: spacing.lg, paddingTop: spacing.xl, paddingBottom: 72, backgroundColor: PORTFOLIO_PAPER },
  portfolioIndex: { color: PORTFOLIO_INK, ...typography.caption, letterSpacing: 1.4, marginBottom: spacing.sm },
  portfolioPhoto: { width: '100%', backgroundColor: '#D8D3C9' },
  portfolioFooter: { minHeight: 260, alignItems: 'center', justifyContent: 'center', paddingHorizontal: spacing.lg, paddingTop: spacing.xl, backgroundColor: PORTFOLIO_PAPER },
  portfolioFooterText: { color: PORTFOLIO_INK, ...typography.caption, letterSpacing: 2, textTransform: 'uppercase' },
  portfolioExit: { minWidth: 176, minHeight: 48, marginTop: spacing.lg, paddingHorizontal: spacing.md, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: spacing.sm, backgroundColor: PORTFOLIO_INK },
  portfolioExitPressed: { opacity: 0.78 },
  portfolioExitText: { color: PORTFOLIO_PAPER, ...typography.label, fontWeight: '800' },
  portfolioControls: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'flex-end', paddingTop: spacing.md, paddingHorizontal: spacing.lg },
  portfolioClose: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(24,23,20,0.84)' },
  portfolioClosePressed: { backgroundColor: PORTFOLIO_INK },
  taskActions: { flexDirection: 'row', gap: spacing.sm },
  importFab: {
    position: 'absolute',
    right: layout.screenPadding,
    bottom: spacing.md,
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.primary,
    zIndex: 10,
  },
  deleteAction: {
    width: layout.minTouchTarget,
    minHeight: layout.minTouchTarget,
    borderRadius: radii.md,
    backgroundColor: colors.surfaceStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  taskAction: { flex: 1 },
  disabled: { opacity: 0.42 },
});
