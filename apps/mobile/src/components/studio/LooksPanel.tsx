import Slider from '@react-native-community/slider';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import {
  Blur,
  Canvas,
  ColorMatrix,
  FractalNoise,
  Group,
  Image as SkiaImage,
  Paint,
  RadialGradient,
  Rect,
  useImage,
  type SkImage,
} from '@shopify/react-native-skia';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import type { SavedStyleProfile } from '../../data/styleRepository';
import { adjustmentPreviewMatrix } from '../../domain/adjustmentPreview';
import type { AdjustmentValues } from '../../domain/types';
import { colors } from '../theme';

const LOOK_PREVIEW_SOURCE = require('../../../assets/look-preview.jpg');
const LOOK_PREVIEW_WIDTH = 108;
const LOOK_PREVIEW_HEIGHT = 81;
const ORIGINAL_LOOK_ADJUSTMENTS: AdjustmentValues = {};

type LooksPanelProps = {
  looks: SavedStyleProfile[];
  selectedLookId?: string;
  strength: number;
  loading: boolean;
  busy: boolean;
  renamingLookId?: string;
  renameBusy: boolean;
  onSelect: (look: SavedStyleProfile) => void;
  onStrengthChange: (strength: number) => void;
  onStrengthCommit: (strength: number) => void;
  onRestore: () => void;
  onStartRename: (lookId: string) => void;
  onRename: (lookId: string, name: string) => void;
  onCancelRename: () => void;
  onDelete: (look: SavedStyleProfile) => void;
};

export const LooksPanel = ({
  looks,
  selectedLookId,
  strength,
  loading,
  busy,
  renamingLookId,
  renameBusy,
  onSelect,
  onStrengthChange,
  onStrengthCommit,
  onRestore,
  onStartRename,
  onRename,
  onCancelRename,
  onDelete,
}: LooksPanelProps) => {
  const selectedLook = looks.find((look) => look.id === selectedLookId);
  const renamingLook = looks.find((look) => look.id === renamingLookId && !look.isBuiltIn);
  const [renameValue, setRenameValue] = useState('');
  const previewImage = useImage(LOOK_PREVIEW_SOURCE);

  useEffect(() => {
    setRenameValue(renamingLook?.name ?? '');
  }, [renamingLook?.id, renamingLook?.name]);

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
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Use original look"
          accessibilityState={{ selected: !selectedLookId, disabled: busy }}
          disabled={busy}
          onPress={onRestore}
          style={({ pressed }) => [
            styles.look,
            !selectedLookId && styles.lookSelected,
            pressed && styles.lookPressed,
          ]}
        >
          <LookPreview image={previewImage} adjustments={ORIGINAL_LOOK_ADJUSTMENTS} />
          <Text numberOfLines={1} style={[styles.lookName, !selectedLookId && styles.lookNameSelected]}>Original</Text>
        </Pressable>

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
              style={({ pressed }) => [styles.look, selected && styles.lookSelected, pressed && styles.lookPressed]}
            >
              <LookPreview image={previewImage} adjustments={look.adjustments} />
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
          {!selectedLook.isBuiltIn && !renamingLook ? (
            <View style={styles.presetActions}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Rename ${selectedLook.name}`}
                disabled={busy || renameBusy}
                onPress={() => onStartRename(selectedLook.id)}
                style={({ pressed }) => [styles.renameTrigger, pressed && styles.lookPressed, (busy || renameBusy) && styles.lookDisabled]}
              >
                <MaterialCommunityIcons name="pencil-outline" size={18} color={colors.text} />
                <Text style={styles.renameTriggerText}>Rename</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Delete ${selectedLook.name}`}
                disabled={busy || renameBusy}
                onPress={() => onDelete(selectedLook)}
                style={({ pressed }) => [styles.deleteTrigger, pressed && styles.lookPressed, (busy || renameBusy) && styles.lookDisabled]}
              >
                <MaterialCommunityIcons name="trash-can-outline" size={18} color={colors.danger} />
                <Text style={styles.deleteTriggerText}>Delete</Text>
              </Pressable>
            </View>
          ) : null}
        </View>
      ) : null}

      {renamingLook ? (
        <View style={styles.renameEditor}>
          <Text style={styles.renameLabel}>Preset name</Text>
          <TextInput
            accessibilityLabel="Preset name"
            autoFocus
            maxLength={40}
            selectTextOnFocus
            returnKeyType="done"
            value={renameValue}
            editable={!renameBusy}
            onChangeText={setRenameValue}
            onSubmitEditing={() => {
              if (renameValue.trim()) onRename(renamingLook.id, renameValue);
            }}
            style={styles.renameInput}
          />
          <View style={styles.renameActions}>
            <Pressable
              accessibilityRole="button"
              disabled={renameBusy}
              onPress={onCancelRename}
              style={({ pressed }) => [styles.renameCancel, pressed && styles.lookPressed, renameBusy && styles.lookDisabled]}
            >
              <Text style={styles.renameCancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !renameValue.trim() || renameBusy, busy: renameBusy }}
              disabled={!renameValue.trim() || renameBusy}
              onPress={() => onRename(renamingLook.id, renameValue)}
              style={({ pressed }) => [styles.renameSave, pressed && styles.renameSavePressed, (!renameValue.trim() || renameBusy) && styles.lookDisabled]}
            >
              {renameBusy ? <ActivityIndicator size="small" color={colors.onPrimary} /> : <Text style={styles.renameSaveText}>Save name</Text>}
            </Pressable>
          </View>
        </View>
      ) : null}
    </>
  );
};

const LookPreview = React.memo(({ image, adjustments }: { image: SkImage | null; adjustments: AdjustmentValues }) => {
  const matrix = adjustmentPreviewMatrix(adjustments);
  const denoise = Math.max(0, adjustments.denoise ?? 0);
  const grain = Math.max(0, adjustments.grain ?? 0);
  const vignette = Math.max(-1, Math.min(1, adjustments.vignette ?? 0));
  return (
    <View style={styles.previewFrame} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Canvas style={styles.previewCanvas}>
        <Group
          layer={(
            <Paint>
              <ColorMatrix matrix={matrix} />
              {denoise > 0 ? <Blur blur={denoise * 1.5} /> : null}
            </Paint>
          )}
        >
          <SkiaImage image={image} x={0} y={0} width={LOOK_PREVIEW_WIDTH} height={LOOK_PREVIEW_HEIGHT} fit="cover" />
        </Group>
        {grain > 0 ? (
          <Group opacity={grain * 0.16} blendMode="overlay">
            <Rect x={0} y={0} width={LOOK_PREVIEW_WIDTH} height={LOOK_PREVIEW_HEIGHT}>
              <FractalNoise freqX={0.72} freqY={0.72} octaves={1} seed={7} />
            </Rect>
          </Group>
        ) : null}
        {vignette !== 0 ? (
          <Group opacity={Math.abs(vignette) * 0.72} blendMode={vignette > 0 ? 'multiply' : 'screen'}>
            <Rect x={0} y={0} width={LOOK_PREVIEW_WIDTH} height={LOOK_PREVIEW_HEIGHT}>
              <RadialGradient
                c={{ x: LOOK_PREVIEW_WIDTH / 2, y: LOOK_PREVIEW_HEIGHT / 2 }}
                r={LOOK_PREVIEW_WIDTH * 0.68}
                colors={vignette > 0 ? ['rgba(0,0,0,0)', '#000000'] : ['rgba(255,255,255,0)', '#FFFFFF']}
                positions={[0.42, 1]}
              />
            </Rect>
          </Group>
        ) : null}
      </Canvas>
    </View>
  );
});

const styles = StyleSheet.create({
  loading: { minHeight: 104 },
  looks: { gap: 10, paddingBottom: 16 },
  look: {
    width: 124,
    minHeight: 123,
    padding: 7,
    borderWidth: 2,
    borderColor: colors.outline,
    borderRadius: 10,
    backgroundColor: colors.controlSurface,
  },
  lookSelected: { borderColor: colors.primary, backgroundColor: colors.surfaceRaised },
  lookDisabled: { opacity: 0.46 },
  previewFrame: { width: LOOK_PREVIEW_WIDTH, height: LOOK_PREVIEW_HEIGHT, overflow: 'hidden', borderRadius: 6, backgroundColor: colors.background },
  previewCanvas: { width: LOOK_PREVIEW_WIDTH, height: LOOK_PREVIEW_HEIGHT },
  lookName: { color: colors.onControlSurface, fontSize: 12, fontWeight: '700', marginTop: 7 },
  lookNameSelected: { color: colors.text },
  empty: { color: colors.textSecondary, fontSize: 13, textAlign: 'center', paddingVertical: 24 },
  controls: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator, paddingTop: 14 },
  strengthHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  strengthStatus: { minWidth: 60, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6 },
  strengthLabel: { color: colors.text, fontSize: 13, fontWeight: '700' },
  strengthValue: { color: colors.textSecondary, fontSize: 12, fontVariant: ['tabular-nums'] },
  slider: { width: '100%', height: 48 },
  lookPressed: { backgroundColor: colors.controlPressed, borderColor: colors.outlineStrong },
  presetActions: { flexDirection: 'row', gap: 10 },
  renameTrigger: { flex: 1, minHeight: 48, borderWidth: 1, borderColor: colors.outline, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  renameTriggerText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  deleteTrigger: { flex: 1, minHeight: 48, borderWidth: 1, borderColor: colors.danger, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  deleteTriggerText: { color: colors.danger, fontSize: 13, fontWeight: '700' },
  renameEditor: { marginTop: 14, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.separator },
  renameLabel: { color: colors.text, fontSize: 13, fontWeight: '700', marginBottom: 8 },
  renameInput: { minHeight: 48, borderWidth: 1, borderColor: colors.outlineStrong, borderRadius: 10, paddingHorizontal: 12, color: colors.text, backgroundColor: colors.background, fontSize: 15 },
  renameActions: { flexDirection: 'row', gap: 10, marginTop: 10 },
  renameCancel: { flex: 1, minHeight: 48, borderWidth: 1, borderColor: colors.outline, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  renameCancelText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  renameSave: { flex: 1, minHeight: 48, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center', justifyContent: 'center' },
  renameSavePressed: { backgroundColor: colors.primaryPressed },
  renameSaveText: { color: colors.onPrimary, fontSize: 13, fontWeight: '800' },
});
