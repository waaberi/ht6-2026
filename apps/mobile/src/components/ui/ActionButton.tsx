import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { colors, layout, radii, spacing, typography } from '../theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

type ActionButtonProps = {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  loading?: boolean;
  icon?: IoniconName;
  variant?: 'filled' | 'tonal' | 'outlined';
  accessibilityHint?: string;
  style?: StyleProp<ViewStyle>;
};

export const ActionButton = ({
  label,
  onPress,
  disabled = false,
  loading = false,
  icon,
  variant = 'filled',
  accessibilityHint,
  style,
}: ActionButtonProps) => (
  <Pressable
    accessibilityRole="button"
    accessibilityLabel={label}
    accessibilityHint={accessibilityHint}
    accessibilityState={{ disabled: disabled || loading, busy: loading }}
    disabled={disabled || loading}
    onPress={onPress}
    style={({ pressed }) => [
      styles.base,
      styles[variant],
      pressed && (variant === 'filled' ? styles.filledPressed : variant === 'tonal' ? styles.tonalPressed : styles.outlinedPressed),
      (disabled || loading) && styles.disabled,
      style,
    ]}
  >
    {loading ? (
      <ActivityIndicator color={variant === 'filled' ? colors.onPrimary : colors.text} />
    ) : (
      <>
        {icon ? <Ionicons name={icon} size={20} color={variant === 'filled' ? colors.onPrimary : colors.text} /> : null}
        <Text numberOfLines={1} style={[styles.label, variant === 'filled' ? styles.filledLabel : styles.secondaryLabel]}>{label}</Text>
      </>
    )}
  </Pressable>
);

const styles = StyleSheet.create({
  base: {
    minHeight: layout.minTouchTarget,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: spacing.sm,
    borderWidth: 1,
  },
  filled: { backgroundColor: colors.primary, borderColor: colors.primary },
  tonal: { backgroundColor: colors.controlSurface, borderColor: colors.outline },
  outlined: { borderColor: colors.outlineStrong, backgroundColor: colors.background },
  label: { flexShrink: 1, ...typography.label, fontWeight: '700', textAlign: 'center' },
  filledLabel: { color: colors.onPrimary },
  secondaryLabel: { color: colors.text },
  filledPressed: { backgroundColor: colors.primaryPressed, borderColor: colors.primaryPressed },
  tonalPressed: { backgroundColor: colors.controlPressed, borderColor: colors.outlineStrong },
  outlinedPressed: { backgroundColor: colors.controlPressed },
  disabled: { opacity: 0.42 },
});
