import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, layout, spacing, typography } from '../theme';

type HeaderAction = {
  label: string;
  icon: React.ComponentProps<typeof Ionicons>['name'];
  onPress: () => void;
  busy?: boolean;
  tone?: 'primary' | 'secondary';
};

export const ScreenHeader = ({ title, detail, action, actions }: {
  title: string;
  detail?: string;
  action?: HeaderAction;
  actions?: HeaderAction[];
}) => {
  const insets = useSafeAreaInsets();
  const visibleActions = actions ?? (action ? [action] : []);

  return (
    <View style={[styles.header, { paddingTop: insets.top + spacing.base }]}>
      <Text accessibilityRole="header" style={styles.title}>{title}</Text>
      <View style={styles.trailing}>
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
        {visibleActions.map((item) => (
          <Pressable
            key={item.label}
            accessibilityRole="button"
            accessibilityLabel={item.label}
            accessibilityState={{ disabled: item.busy, busy: item.busy }}
            disabled={item.busy}
            style={({ pressed }) => [styles.action, item.tone === 'primary' && styles.primaryAction, pressed && styles.pressed]}
            onPress={item.onPress}
          >
            {item.busy ? (
              <ActivityIndicator size="small" color={item.tone === 'primary' ? colors.onPrimary : colors.text} />
            ) : (
              <Ionicons name={item.icon} size={24} color={item.tone === 'primary' ? colors.onPrimary : colors.text} />
            )}
          </Pressable>
        ))}
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
    width: '100%',
    maxWidth: layout.screenMaxWidth,
    alignSelf: 'center',
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
  primaryAction: { backgroundColor: colors.primary },
  pressed: { backgroundColor: colors.pressed },
});
