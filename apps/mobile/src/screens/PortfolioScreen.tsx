import { FlashList } from '@shopify/flash-list';
import React, { useMemo, useState } from 'react';
import { AccessibilityInfo, Image, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { colors, layout, radii, spacing, typography } from '../components/theme';
import { ActionButton } from '../components/ui/ActionButton';
import { EmptyState } from '../components/ui/EmptyState';
import { ScreenHeader } from '../components/ui/ScreenHeader';
import { SelectablePhotoTile } from '../components/ui/SelectablePhotoTile';
import { StickyActionBar } from '../components/ui/StickyActionBar';
import { reviewPortfolio, type PortfolioReview } from '../services/api';
import { persistPortfolioReview } from '../services/sync';
import { useExposure } from '../state/ExposureContext';

export const PortfolioScreen = () => {
  const { width } = useWindowDimensions();
  const { photos } = useExposure();
  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState<PortfolioReview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const columnCount = width >= 900 ? 7 : width >= 600 ? 5 : 3;
  const photoById = useMemo(() => new Map(photos.map((photo) => [photo.id, photo])), [photos]);

  const toggle = (id: string) => {
    setNotice(undefined);
    setReview(undefined);
    setSelected((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length < 20) return [...current, id];
      const message = 'You can select up to 20 photos.';
      setNotice(message);
      AccessibilityInfo.announceForAccessibility(message);
      return current;
    });
  };

  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await reviewPortfolio(photos.filter((photo) => selected.includes(photo.id)));
      setReview(result);
      await persistPortfolioReview(result, selected);
      AccessibilityInfo.announceForAccessibility('Portfolio review ready.');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Portfolio review failed.');
    } finally {
      setBusy(false);
    }
  };

  const listHeader = (
    <>
      <ScreenHeader title="Portfolio" detail={`${selected.length}/20`} />
      <Text style={styles.instruction}>Select 2–20 photos</Text>
      {notice ? <Text accessibilityLiveRegion="polite" style={styles.notice}>{notice}</Text> : null}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </>
  );

  const listFooter = review ? (
    <View style={styles.review} accessibilityLiveRegion="polite">
      <Text accessibilityRole="header" style={styles.reviewTitle}>Recommended order</Text>
      {review.summary ? <Text style={styles.reviewSummary}>{review.summary}</Text> : null}
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
  ) : <View style={styles.footerSpacer} />;

  return (
    <View style={styles.screen}>
      {photos.length === 0 ? (
        <>
          <ScreenHeader title="Portfolio" detail="0/20" />
          <EmptyState icon="albums-outline" title="No photos to review" />
        </>
      ) : (
        <FlashList
          key={`portfolio-${columnCount}`}
          data={photos}
          extraData={selected}
          numColumns={columnCount}
          contentContainerStyle={styles.content}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={listHeader}
          ListFooterComponent={listFooter}
          renderItem={({ item }) => (
            <SelectablePhotoTile
              photo={item}
              selected={selected.includes(item.id)}
              order={selected.indexOf(item.id) + 1}
              onPress={() => toggle(item.id)}
            />
          )}
        />
      )}
      {photos.length ? (
        <StickyActionBar>
          <ActionButton
            label={selected.length >= 2 ? `Review ${selected.length} photos` : 'Select at least 2 photos'}
            onPress={run}
            disabled={selected.length < 2}
            loading={busy}
          />
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
  review: {
    marginHorizontal: spacing.md,
    marginTop: spacing.lg,
    padding: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    marginBottom: spacing.md,
  },
  reviewTitle: {
    color: colors.text,
    fontFamily: typography.displayFamily,
    ...typography.title,
  },
  reviewSummary: { color: colors.textSecondary, ...typography.body, marginTop: spacing.xs, marginBottom: spacing.md },
  rankRow: {
    minHeight: 72,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.base,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.outline,
  },
  rankNumber: { width: 24, color: colors.text, ...typography.section, fontWeight: '800', textAlign: 'center' },
  rankImage: { width: 52, height: 52, borderRadius: radii.sm, backgroundColor: colors.background },
  rankText: { flex: 1, color: colors.text, ...typography.label },
  footerSpacer: { height: spacing.md },
});
