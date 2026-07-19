import { MaterialCommunityIcons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AdjustmentValues, CanvasTransform } from '../../domain/types';
import { colors } from '../theme';
import { TransformSheet } from './TransformSheet';

type AdjustmentKey = keyof AdjustmentValues;
export type AdjustmentSection = 'light' | 'color' | 'detail' | 'crop';

const controls: Array<{ key: AdjustmentKey; label: string; section: Exclude<AdjustmentSection, 'crop'>; minimum: number; maximum: number; step: number }> = [
  { key: 'exposure', label: 'Exposure', section: 'light', minimum: -1, maximum: 1, step: 0.01 },
  { key: 'contrast', label: 'Contrast', section: 'light', minimum: -1, maximum: 1, step: 0.01 },
  { key: 'highlights', label: 'Highlights', section: 'light', minimum: -1, maximum: 1, step: 0.01 },
  { key: 'shadows', label: 'Shadows', section: 'light', minimum: -1, maximum: 1, step: 0.01 },
  { key: 'temperature', label: 'Temperature', section: 'color', minimum: -1, maximum: 1, step: 0.01 },
  { key: 'tint', label: 'Tint', section: 'color', minimum: -1, maximum: 1, step: 0.01 },
  { key: 'saturation', label: 'Saturation', section: 'color', minimum: -1, maximum: 1, step: 0.01 },
  { key: 'vibrance', label: 'Vibrance', section: 'color', minimum: -1, maximum: 1, step: 0.01 },
  { key: 'sharpening', label: 'Sharpen', section: 'detail', minimum: 0, maximum: 1, step: 0.01 },
  { key: 'denoise', label: 'Denoise', section: 'detail', minimum: 0, maximum: 1, step: 0.01 },
  { key: 'grain', label: 'Grain', section: 'detail', minimum: 0, maximum: 1, step: 0.01 },
  { key: 'vignette', label: 'Vignette', section: 'detail', minimum: -1, maximum: 1, step: 0.01 },
];

const sections: Array<{ id: AdjustmentSection; label: string }> = [
  { id: 'light', label: 'Light' },
  { id: 'color', label: 'Color' },
  { id: 'detail', label: 'Detail' },
  { id: 'crop', label: 'Crop' },
];

export const AdjustmentSheet = ({
  values,
  onChange,
  onCommit,
  onResetControl,
  onRestore,
  busy,
  section,
  onSectionChange,
  transform,
  imageWidth,
  imageHeight,
  onAngleChange,
  onAngleCommit,
  onCrop,
  onFreeformCrop,
  lockedCropAspect,
  onRotate,
  onRestoreTransform,
}: {
  values: AdjustmentValues;
  onChange: (key: AdjustmentKey, value: number) => void;
  onCommit: (key: AdjustmentKey, value: number) => void;
  onResetControl: (key: AdjustmentKey) => void;
  onRestore: () => void;
  busy: boolean;
  section: AdjustmentSection;
  onSectionChange: (section: AdjustmentSection) => void;
  transform: CanvasTransform;
  imageWidth?: number;
  imageHeight?: number;
  onAngleChange: (degrees: number) => void;
  onAngleCommit: (degrees: number) => void;
  onCrop: (aspect: number | undefined) => void;
  onFreeformCrop: () => void;
  lockedCropAspect?: number;
  onRotate: () => void;
  onRestoreTransform: () => void;
}) => {
  const hasChanges = Object.values(values).some((value) => Math.abs(value ?? 0) > 0.0001);
  return (
    <View>
      <View accessibilityRole="tablist" style={styles.sections}>
        {sections.map((item) => (
          <Pressable
            key={item.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: item.id === section }}
            style={({ pressed }) => [
              styles.section,
              item.id === section && styles.sectionSelected,
              pressed && (item.id === section ? styles.primaryPressed : styles.controlPressed),
            ]}
            onPress={() => onSectionChange(item.id)}
          >
            <Text style={[styles.sectionText, item.id === section && styles.sectionTextSelected]}>{item.label}</Text>
          </Pressable>
        ))}
      </View>

      {section === 'crop' ? (
        <TransformSheet
          transform={transform}
          width={imageWidth}
          height={imageHeight}
          busy={busy}
          onStraightenChange={onAngleChange}
          onStraightenCommit={onAngleCommit}
          onCrop={onCrop}
          onFreeform={onFreeformCrop}
          lockedAspect={lockedCropAspect}
          onRotate={onRotate}
          onRestore={onRestoreTransform}
        />
      ) : null}

      {section !== 'crop' ? <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Reset all adjustments"
          disabled={!hasChanges || busy}
          style={({ pressed }) => [styles.restore, pressed && styles.controlPressed, (!hasChanges || busy) && styles.disabled]}
          onPress={onRestore}
        >
          <MaterialCommunityIcons name="restore" size={19} color={hasChanges ? colors.text : colors.textSecondary} />
          <Text style={[styles.restoreText, !hasChanges && styles.disabledText]}>Reset</Text>
        </Pressable>
      </View> : null}

      {controls.filter((control) => control.section === section).map((control) => {
        const value = values[control.key] ?? 0;
        const changed = Math.abs(value) > 0.0001;
        return (
          <View key={control.key} style={styles.control}>
            <View style={styles.controlHeading}>
              <Text style={styles.label}>{control.label}</Text>
              <View style={styles.valueGroup}>
                <Text style={styles.value}>{control.key === 'exposure' ? `${value >= 0 ? '+' : ''}${value.toFixed(2)} EV` : Math.round(value * 100)}</Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Reset ${control.label}`}
                  accessibilityState={{ disabled: !changed || busy }}
                  disabled={!changed || busy}
                  style={({ pressed }) => [styles.resetControl, pressed && styles.controlPressed, !changed && styles.resetControlIdle]}
                  onPress={() => onResetControl(control.key)}
                >
                  <MaterialCommunityIcons name="restore" size={17} color={changed ? colors.text : colors.textSecondary} />
                </Pressable>
              </View>
            </View>
            <Slider
              accessibilityLabel={control.label}
              accessibilityHint="Changes apply when you release the slider"
              minimumValue={control.minimum}
              maximumValue={control.maximum}
              step={control.step}
              value={value}
              disabled={busy}
              onValueChange={(next) => onChange(control.key, next)}
              onSlidingComplete={(next) => onCommit(control.key, next)}
              minimumTrackTintColor={colors.primary}
              maximumTrackTintColor={colors.outline}
              thumbTintColor={colors.text}
            />
          </View>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  sections: { flexDirection: 'row', gap: 4, padding: 4, borderRadius: 10, backgroundColor: colors.background, marginBottom: 10 },
  section: { flex: 1, minHeight: 48, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  sectionSelected: { backgroundColor: colors.primary },
  primaryPressed: { backgroundColor: colors.primaryPressed },
  controlPressed: { backgroundColor: colors.controlPressed },
  sectionText: { color: colors.textSecondary, fontSize: 12, fontWeight: '700' },
  sectionTextSelected: { color: colors.onPrimary },
  toolbar: { minHeight: 48, flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', marginBottom: 2 },
  restore: { minWidth: 96, minHeight: 48, borderRadius: 24, borderWidth: 1, borderColor: colors.outline, paddingHorizontal: 12, flexDirection: 'row', gap: 7, alignItems: 'center', justifyContent: 'center' },
  restoreText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  control: { marginBottom: 8 },
  controlHeading: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingLeft: 4 },
  label: { color: colors.text, fontSize: 13, fontWeight: '700' },
  value: { color: colors.textSecondary, fontSize: 12, fontVariant: ['tabular-nums'] },
  valueGroup: { minWidth: 98, minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4 },
  resetControl: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  resetControlIdle: { opacity: 0.28 },
  disabled: { opacity: 0.42 },
  disabledText: { color: colors.textSecondary },
});
