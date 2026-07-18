import { FlashList } from '@shopify/flash-list';
import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from '../components/theme';
import type { PhotoRecord } from '../domain/types';
import { useExposure } from '../state/ExposureContext';

export const LibraryScreen = ({ onOpenStudio }: { onOpenStudio: () => void }) => {
  const { photos, selectPhoto } = useExposure();

  const open = (photo: PhotoRecord) => {
    selectPhoto(photo.id);
    onOpenStudio();
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.eyebrow}>EXPOSURE ARCHIVE</Text>
        <Text style={styles.title}>Library</Text>
        <Text style={styles.count}>{photos.length} immutable original{photos.length === 1 ? '' : 's'}</Text>
      </View>
      {photos.length === 0 ? (
        <View style={styles.empty}>
          <Text style={styles.emptyMark}>▦</Text>
          <Text style={styles.emptyTitle}>No photographs yet</Text>
          <Text style={styles.emptyBody}>Capture or import from the Camera tab. Originals stay untouched.</Text>
        </View>
      ) : (
        <FlashList
          data={photos}
          numColumns={2}
          contentContainerStyle={styles.grid}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <Pressable style={styles.tile} onPress={() => open(item)}>
              <Image source={{ uri: item.thumbnailUri }} style={styles.image} resizeMode="cover" />
              <View style={styles.tileFooter}>
                <Text numberOfLines={1} style={styles.name}>{item.originalName}</Text>
                <Text style={styles.meta}>{item.versions.length - 1} edits · {item.syncState}</Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  );
};

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  header: { paddingHorizontal: 20, paddingTop: 26, paddingBottom: 18 },
  eyebrow: { color: colors.lime, fontSize: 9, fontWeight: '800', letterSpacing: 2.3 },
  title: { color: colors.ink, fontSize: 34, fontWeight: '900', marginTop: 5 },
  count: { color: colors.muted, fontSize: 12, marginTop: 4 },
  grid: { paddingHorizontal: 7, paddingBottom: 20 },
  tile: { flex: 1, margin: 5, backgroundColor: colors.panel, borderRadius: 5, overflow: 'hidden', borderWidth: 1, borderColor: colors.line },
  image: { width: '100%', aspectRatio: 0.9, backgroundColor: colors.panelRaised },
  tileFooter: { padding: 10 },
  name: { color: colors.ink, fontSize: 12, fontWeight: '700' },
  meta: { color: colors.muted, fontSize: 9, marginTop: 3, textTransform: 'uppercase' },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 44, paddingBottom: 80 },
  emptyMark: { color: colors.line, fontSize: 64 },
  emptyTitle: { color: colors.ink, fontWeight: '800', fontSize: 20, marginTop: 16 },
  emptyBody: { color: colors.muted, textAlign: 'center', lineHeight: 20, marginTop: 8 },
});
