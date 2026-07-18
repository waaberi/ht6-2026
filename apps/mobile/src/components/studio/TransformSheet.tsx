import { MaterialCommunityIcons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { hasManualTransform, quarterTurnsForRotation, straightenDegrees, visibleCropAspect } from '../../domain/canvasTransforms';
import type { CanvasTransform } from '../../domain/types';
import { colors } from '../theme';

const matches = (transform: CanvasTransform, aspect: number | undefined, width?: number, height?: number) => {
  if (aspect === undefined) return !transform.crop;
  if (!transform.crop) return false;
  return Math.abs(visibleCropAspect(width, height, transform) - aspect) < 0.02;
};

export const TransformSheet = ({
  transform,
  width,
  height,
  busy,
  onStraightenChange,
  onStraightenCommit,
  onCrop,
  onFreeform,
  lockedAspect,
  onRotate,
  onRestore,
}: {
  transform: CanvasTransform;
  width?: number;
  height?: number;
  busy: boolean;
  onStraightenChange: (degrees: number) => void;
  onStraightenCommit: (degrees: number) => void;
  onCrop: (aspect: number | undefined) => void;
  onFreeform: () => void;
  lockedAspect?: number;
  onRotate: () => void;
  onRestore: () => void;
}) => {
  const straighten = straightenDegrees(transform.rotationDegrees);
  const changed = hasManualTransform(transform);
  const imageAspect = Math.max(1, width ?? 1) / Math.max(1, height ?? 1);
  const swapsDimensions = Math.abs(quarterTurnsForRotation(transform.rotationDegrees)) % 2 === 1;
  const outputAspect = swapsDimensions ? 1 / imageAspect : imageAspect;
  const portrait = outputAspect < 1;
  const aspectOptions = [
    { id: 'original', label: 'Original', aspect: undefined },
    { id: 'free', label: 'Free', aspect: undefined },
    { id: 'square', label: '1:1', aspect: 1 },
    { id: 'classic', label: portrait ? '3:4' : '4:3', aspect: portrait ? 3 / 4 : 4 / 3 },
    { id: 'wide', label: portrait ? '9:16' : '16:9', aspect: portrait ? 9 / 16 : 16 / 9 },
  ];
  return (
    <View>
      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Rotate 90 degrees clockwise"
          disabled={busy}
          style={({ pressed }) => [styles.toolbarButton, busy && styles.disabled, pressed && styles.pressed]}
          onPress={onRotate}
        >
          <MaterialCommunityIcons name="rotate-right" size={20} color={colors.ink} />
          <Text style={styles.toolbarText}>Rotate</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Restore crop and rotation"
          disabled={!changed || busy}
          style={({ pressed }) => [styles.toolbarButton, (!changed || busy) && styles.disabled, pressed && styles.pressed]}
          onPress={onRestore}
        >
          <MaterialCommunityIcons name="restore" size={20} color={changed ? colors.ink : colors.muted} />
          <Text style={[styles.toolbarText, !changed && styles.muted]}>Restore</Text>
        </Pressable>
      </View>

      <Text style={styles.sectionTitle}>Crop</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.aspects}>
        {aspectOptions.map((option) => {
          const selected = option.id === 'original'
            ? !transform.crop
            : option.id === 'free'
              ? Boolean(transform.crop) && lockedAspect === undefined
              : lockedAspect === option.aspect && matches(transform, option.aspect, width, height);
          return (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              disabled={busy}
              style={({ pressed }) => [styles.aspect, selected && styles.aspectSelected, pressed && styles.pressed]}
              onPress={() => option.id === 'free' ? onFreeform() : onCrop(option.aspect)}
            >
              <Text style={[styles.aspectText, selected && styles.aspectTextSelected]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.sliderHeading}>
        <Text style={styles.sectionTitle}>Angle</Text>
        <Text style={styles.value}>{straighten > 0 ? '+' : ''}{straighten.toFixed(1)}°</Text>
      </View>
      <Slider
        accessibilityLabel="Rotate photo angle"
        accessibilityHint="Changes apply when you release the slider"
        minimumValue={-45}
        maximumValue={45}
        step={0.1}
        value={straighten}
        disabled={busy}
        onValueChange={onStraightenChange}
        onSlidingComplete={onStraightenCommit}
        minimumTrackTintColor={colors.lime}
        maximumTrackTintColor={colors.line}
        thumbTintColor={colors.ink}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  toolbar: { minHeight: 52, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  toolbarButton: { minWidth: 104, minHeight: 48, borderRadius: 24, paddingHorizontal: 14, flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center' },
  toolbarText: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  sectionTitle: { color: colors.ink, fontSize: 13, fontWeight: '800', marginBottom: 8 },
  aspects: { gap: 8, paddingBottom: 18 },
  aspect: { minWidth: 76, minHeight: 48, borderRadius: 24, paddingHorizontal: 14, borderWidth: 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' },
  aspectSelected: { backgroundColor: colors.lime, borderColor: colors.lime },
  aspectText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  aspectTextSelected: { color: colors.limeInk },
  sliderHeading: { minHeight: 36, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  value: { color: colors.muted, fontSize: 12, fontVariant: ['tabular-nums'] },
  muted: { color: colors.muted },
  disabled: { opacity: 0.42 },
  pressed: { opacity: 0.68 },
});
