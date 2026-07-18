import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

import type { PhotoRecord } from '../../domain/types';
import { colors, radii, spacing, typography } from '../theme';

export const SelectablePhotoTile = ({
  photo,
  selected,
  order,
  onPress,
  aspectRatio = 0.88,
}: {
  photo: PhotoRecord;
  selected: boolean;
  order?: number;
  onPress: () => void;
  aspectRatio?: number;
}) => (
  <Pressable
    accessibilityRole="checkbox"
    accessibilityLabel={photo.originalName}
    accessibilityHint={selected ? 'Double tap to remove from selection' : 'Double tap to select'}
    accessibilityState={{ checked: selected }}
    onPress={onPress}
    style={({ pressed }) => [styles.tile, { aspectRatio }, selected && styles.selected, pressed && styles.pressed]}
  >
    <Image source={{ uri: photo.thumbnailUri }} style={styles.image} resizeMode="cover" accessible={false} />
    <View style={[styles.badge, selected && styles.badgeSelected]} accessibilityElementsHidden>
      {selected && order ? (
        <Text style={styles.order}>{order}</Text>
      ) : (
        <Ionicons name={selected ? 'checkmark' : 'add'} size={18} color={selected ? colors.onPrimary : colors.text} />
      )}
    </View>
  </Pressable>
);

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    margin: spacing.xxs,
    position: 'relative',
    borderWidth: 2,
    borderColor: 'transparent',
    borderRadius: radii.sm,
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  selected: { borderColor: colors.primary },
  pressed: { opacity: 0.82 },
  image: { width: '100%', height: '100%' },
  badge: {
    position: 'absolute',
    top: spacing.xs,
    right: spacing.xs,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.text,
  },
  badgeSelected: { backgroundColor: colors.primary, borderColor: colors.primary },
  order: { color: colors.onPrimary, ...typography.label, fontWeight: '800' },
});
