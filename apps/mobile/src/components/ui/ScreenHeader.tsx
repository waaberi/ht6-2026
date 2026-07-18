import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, layout, spacing, typography } from '../theme';

export const ScreenHeader = ({ title, detail, action }: {
  title: string;
  detail?: string;
  action?: { label: string; icon: React.ComponentProps<typeof Ionicons>['name']; onPress: () => void; busy?: boolean };
}) => {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.header, { paddingTop: insets.top + spacing.base }]}>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      <View style={styles.trailing}>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
        {action ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={action.label}
            disabled={action.busy}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            onPress={action.onPress}
          >
            {action.busy ? <ActivityIndicator size="small" color={colors.text} /> : <Ionicons name={action.icon} size={24} color={colors.text} />}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  header: {
    paddingHorizontal: layout.screenPadding,
    paddingBottom: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  title: {
    color: colors.text,
    fontFamily: typography.displayFamily,
    ...typography.display,
  },
  detail: {
    color: colors.textSecondary,
    ...typography.label,
    fontWeight: '600',
  },
  trailing: { minHeight: 48, flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  action: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surface, overflow: 'hidden' },
  pressed: { backgroundColor: colors.pressed },
});
