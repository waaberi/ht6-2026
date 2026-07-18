import React, { useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors } from '../components/theme';
import { reviewPortfolio, type PortfolioReview } from '../services/api';
import { persistPortfolioReview } from '../services/sync';
import { useExposure } from '../state/ExposureContext';

export const PortfolioScreen = () => {
  const { photos } = useExposure();
  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState<PortfolioReview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length < 20 ? [...current, id] : current);
  const run = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await reviewPortfolio(photos.filter((photo) => selected.includes(photo.id)));
      setReview(result);
      await persistPortfolioReview(result, selected);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Portfolio review failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.eyebrow}>CURATION DESK</Text>
      <Text style={styles.title}>Portfolio</Text>
      <Text style={styles.intro}>Select up to 20 frames. Exposure looks for impact, consistency, clarity and near-duplicates without hiding anything.</Text>
      <View style={styles.counter}><Text style={styles.counterValue}>{selected.length}</Text><Text style={styles.counterLabel}> / 20 SELECTED</Text></View>
      <View style={styles.grid}>
        {photos.map((photo) => {
          const chosen = selected.includes(photo.id);
          return (
            <Pressable key={photo.id} style={[styles.tile, chosen && styles.tileSelected]} onPress={() => toggle(photo.id)}>
              <Image source={{ uri: photo.thumbnailUri }} style={styles.image} />
              <View style={[styles.badge, chosen && styles.badgeSelected]}><Text style={styles.badgeText}>{chosen ? selected.indexOf(photo.id) + 1 : '+'}</Text></View>
            </Pressable>
          );
        })}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Pressable style={[styles.primary, selected.length < 2 && styles.disabled]} disabled={selected.length < 2 || busy} onPress={run}>
        {busy ? <ActivityIndicator color={colors.limeInk} /> : <Text style={styles.primaryText}>Review selected photographs</Text>}
      </Pressable>
      {review ? (
        <View style={styles.review}>
          <Text style={styles.reviewTitle}>Recommended sequence</Text>
          <Text style={styles.reviewBody}>{review.summary}</Text>
          {review.orderedPhotoIds.map((id, index) => <Text key={id} style={styles.rank}>{index + 1}. {review.explanations[id] ?? id}</Text>)}
          {review.excludedPhotoIds.length ? <Text style={styles.excluded}>{review.excludedPhotoIds.length} frame(s) remain in Library but are outside this set.</Text> : null}
        </View>
      ) : null}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  content: { padding: 20, paddingBottom: 50 },
  eyebrow: { color: colors.lime, fontWeight: '900', fontSize: 9, letterSpacing: 2.2, marginTop: 6 },
  title: { color: colors.ink, fontSize: 34, fontWeight: '900', marginTop: 5 },
  intro: { color: colors.muted, fontSize: 13, lineHeight: 20, marginTop: 8 },
  counter: { flexDirection: 'row', alignItems: 'baseline', marginTop: 20 },
  counterValue: { color: colors.ink, fontSize: 26, fontWeight: '900' },
  counterLabel: { color: colors.muted, fontSize: 9, fontWeight: '800', letterSpacing: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, marginTop: 12 },
  tile: { width: '31.5%', aspectRatio: 0.85, borderWidth: 2, borderColor: 'transparent', position: 'relative' },
  tileSelected: { borderColor: colors.lime },
  image: { width: '100%', height: '100%', backgroundColor: colors.panelRaised },
  badge: { position: 'absolute', top: 5, right: 5, width: 23, height: 23, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.66)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.ink },
  badgeSelected: { backgroundColor: colors.lime, borderColor: colors.lime },
  badgeText: { color: colors.ink, fontSize: 11, fontWeight: '900' },
  primary: { minHeight: 48, marginTop: 18, borderRadius: 3, backgroundColor: colors.lime, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: colors.limeInk, fontWeight: '900', fontSize: 12 },
  disabled: { opacity: 0.35 },
  error: { color: colors.danger, fontSize: 11, marginTop: 12 },
  review: { backgroundColor: colors.panel, borderLeftWidth: 3, borderLeftColor: colors.lime, padding: 16, marginTop: 18 },
  reviewTitle: { color: colors.ink, fontSize: 18, fontWeight: '900' },
  reviewBody: { color: colors.muted, lineHeight: 18, fontSize: 12, marginTop: 6, marginBottom: 10 },
  rank: { color: colors.ink, fontSize: 11, lineHeight: 18 },
  excluded: { color: colors.amber, fontSize: 10, marginTop: 12 },
});
