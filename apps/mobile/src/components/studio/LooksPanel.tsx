import Slider from '@react-native-community/slider';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { SavedStyleProfile } from '../../data/styleRepository';
import { colors } from '../theme';

type LooksPanelProps = {
  looks: SavedStyleProfile[];
  selectedLookId?: string;
  strength: number;
  loading: boolean;
  busy: boolean;
  canRestore: boolean;
  onSelect: (look: SavedStyleProfile) => void;
  onStrengthChange: (strength: number) => void;
  onStrengthCommit: (strength: number) => void;
  onRestore: () => void;
};

export const LooksPanel = ({
  looks,
  selectedLookId,
  strength,
  loading,
  busy,
  canRestore,
  onSelect,
  onStrengthChange,
  onStrengthCommit,
  onRestore,
}: LooksPanelProps) => {
  const selectedLook = looks.find((look) => look.id === selectedLookId);

  if (loading) {
    return <ActivityIndicator style={styles.loading} color={colors.primary} />;
  }

  return (
    <>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.looks}
      >
        {looks.length > 0 || canRestore ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Restore original look"
            accessibilityState={{ selected: !selectedLookId, disabled: busy || !canRestore }}
            disabled={busy || !canRestore}
            onPress={onRestore}
            style={({ pressed }) => [
              styles.look,
              !selectedLookId && styles.lookSelected,
              !canRestore && styles.lookDisabled,
              pressed && styles.pressed,
            ]}
          >
            <View style={styles.originalPreview}>
              <MaterialCommunityIcons name="image-off-outline" size={22} color={colors.textSecondary} />
            </View>
            <Text numberOfLines={1} style={[styles.lookName, !selectedLookId && styles.lookNameSelected]}>Original</Text>
          </Pressable>
        ) : null}

        {looks.map((look) => {
          const selected = look.id === selectedLookId;
          return (
            <Pressable
              key={look.id}
              accessibilityRole="button"
              accessibilityLabel={look.name}
              accessibilityState={{ selected, disabled: busy }}
              disabled={busy}
              onPress={() => onSelect(look)}
              style={({ pressed }) => [styles.look, selected && styles.lookSelected, pressed && styles.pressed]}
            >
              <View style={styles.palette} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
                {look.palette.slice(0, 4).map((color, index) => (
                  <View key={`${color}-${index}`} style={[styles.swatch, { backgroundColor: color }]} />
                ))}
              </View>
              <Text numberOfLines={1} style={[styles.lookName, selected && styles.lookNameSelected]}>{look.name}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {looks.length === 0 ? <Text style={styles.empty}>No saved Looks</Text> : null}

      {selectedLook ? (
        <View style={styles.controls}>
          <View style={styles.strengthHeader}>
            <Text style={styles.strengthLabel}>Strength</Text>
            <View style={styles.strengthStatus}>
              {busy ? <ActivityIndicator size="small" color={colors.primary} /> : null}
              <Text style={styles.strengthValue}>{Math.round(strength * 100)}%</Text>
            </View>
          </View>
          <Slider
            accessibilityLabel={`${selectedLook.name} strength`}
            accessibilityValue={{
              min: 0,
              max: 100,
              now: Math.round(strength * 100),
              text: `${Math.round(strength * 100)} percent`,
            }}
            style={styles.slider}
            minimumValue={0}
            maximumValue={1}
            step={0.01}
            value={strength}
            onValueChange={onStrengthChange}
            onSlidingComplete={onStrengthCommit}
            minimumTrackTintColor={colors.primary}
            maximumTrackTintColor={colors.outlineStrong}
            thumbTintColor={colors.text}
            disabled={busy}
          />
        </View>
      ) : null}
    </>
  );
};

const styles = StyleSheet.create({
  loading: { minHeight: 104 },
  looks: { gap: 10, paddingBottom: 16 },
  look: {
    width: 104,
    minHeight: 78,
    padding: 7,
    borderWidth: 2,
    borderColor: colors.outline,
    borderRadius: 10,
    backgroundColor: colors.surface,
  },
  lookSelected: { borderColor: colors.primary },
  lookDisabled: { opacity: 0.46 },
  palette: { height: 36, flexDirection: 'row', overflow: 'hidden', borderRadius: 6 },
  swatch: { flex: 1 },
  originalPreview: {
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 6,
    backgroundColor: colors.background,
  },
  lookName: { color: colors.textSecondary, fontSize: 12, fontWeight: '700', marginTop: 7 },
  lookNameSelected: { color: colors.text },
  empty: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', paddingVertical: 24 },
  controls: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.outline, paddingTop: 14 },
  strengthHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  strengthStatus: { minWidth: 60, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 },
  strengthLabel: { color: colors.text, fontSize: 13, fontWeight: '700' },
  strengthValue: { color: colors.textSecondary, fontSize: 12, fontVariant: ['tabular-nums'] },
  slider: { width: '100%', height: 48 },
  pressed: { opacity: 0.72 },
});
