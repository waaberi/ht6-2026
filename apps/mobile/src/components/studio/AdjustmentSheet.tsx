import { MaterialCommunityIcons } from '@expo/vector-icons';
import Slider from '@react-native-community/slider';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AdjustmentValues } from '../../domain/types';
import { colors } from '../theme';

type AdjustmentKey = keyof AdjustmentValues;

const controls: Array<{ key: AdjustmentKey; label: string; minimum: number; maximum: number; step: number }> = [
  { key: 'exposure', label: 'Exposure', minimum: -1, maximum: 1, step: 0.01 },
  { key: 'contrast', label: 'Contrast', minimum: -1, maximum: 1, step: 0.01 },
  { key: 'highlights', label: 'Highlights', minimum: -1, maximum: 1, step: 0.01 },
  { key: 'shadows', label: 'Shadows', minimum: -1, maximum: 1, step: 0.01 },
  { key: 'temperature', label: 'Temperature', minimum: -1, maximum: 1, step: 0.01 },
  { key: 'tint', label: 'Tint', minimum: -1, maximum: 1, step: 0.01 },
  { key: 'saturation', label: 'Saturation', minimum: -1, maximum: 1, step: 0.01 },
  { key: 'vibrance', label: 'Vibrance', minimum: -1, maximum: 1, step: 0.01 },
  { key: 'sharpening', label: 'Sharpen', minimum: 0, maximum: 1, step: 0.01 },
  { key: 'denoise', label: 'Denoise', minimum: 0, maximum: 1, step: 0.01 },
  { key: 'grain', label: 'Grain', minimum: 0, maximum: 1, step: 0.01 },
  { key: 'vignette', label: 'Vignette', minimum: -1, maximum: 1, step: 0.01 },
];

export const AdjustmentSheet = ({
  values,
  onChange,
  onCommit,
  onResetControl,
  onRestore,
  busy,
}: {
  values: AdjustmentValues;
  onChange: (key: AdjustmentKey, value: number) => void;
  onCommit: (key: AdjustmentKey, value: number) => void;
  onResetControl: (key: AdjustmentKey) => void;
  onRestore: () => void;
  busy: boolean;
}) => {
  const hasChanges = Object.values(values).some((value) => Math.abs(value ?? 0) > 0.0001);
  return (
    <View>
      <View style={styles.toolbar}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Restore all adjustments"
          disabled={!hasChanges || busy}
          style={({ pressed }) => [styles.restore, (!hasChanges || busy) && styles.disabled, pressed && styles.pressed]}
          onPress={onRestore}
        >
          <MaterialCommunityIcons name="restore" size={19} color={hasChanges ? colors.text : colors.textSecondary} />
          <Text style={[styles.restoreText, !hasChanges && styles.disabledText]}>Restore</Text>
        </Pressable>
      </View>
      {controls.map((control) => {
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
                  style={({ pressed }) => [styles.resetControl, !changed && styles.resetControlIdle, pressed && styles.pressed]}
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
  pressed: { opacity: 0.68 },
});
