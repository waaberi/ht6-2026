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
      pressed && styles.pressed,
      (disabled || loading) && styles.disabled,
      style,
    ]}
  >
    {loading ? (
      <ActivityIndicator color={variant === 'filled' ? colors.onPrimary : colors.text} />
    ) : (
      <>
        {icon ? <Ionicons name={icon} size={20} color={variant === 'filled' ? colors.onPrimary : colors.text} /> : null}
        <Text style={[styles.label, variant === 'filled' ? styles.filledLabel : styles.secondaryLabel]}>{label}</Text>
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
  },
  filled: { backgroundColor: colors.primary },
  tonal: { backgroundColor: colors.surface },
  outlined: { borderWidth: 1, borderColor: colors.outlineStrong, backgroundColor: colors.background },
  label: { ...typography.label, fontWeight: '700' },
  filledLabel: { color: colors.onPrimary },
  secondaryLabel: { color: colors.text },
  pressed: { opacity: 0.82 },
  disabled: { opacity: 0.42 },
});
