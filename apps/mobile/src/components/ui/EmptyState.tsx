import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps, PropsWithChildren } from 'react';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, layout, spacing, typography } from '../theme';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

export const EmptyState = ({
  icon,
  title,
  body,
  children,
}: PropsWithChildren<{ icon: IoniconName; title: string; body?: string }>) => (
  <View style={styles.empty}>
    <Ionicons name={icon} size={34} color={colors.textSecondary} accessibilityElementsHidden />
    <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    {body ? <Text style={styles.body}>{body}</Text> : null}
    {children ? <View style={styles.actions}>{children}</View> : null}
  </View>
);

const styles = StyleSheet.create({
  empty: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: layout.screenPadding + spacing.lg,
    paddingBottom: spacing.xl,
  },
  title: {
    color: colors.text,
    fontFamily: typography.displayFamily,
    ...typography.title,
    textAlign: 'center',
    marginTop: spacing.md,
  },
  body: {
    color: colors.textSecondary,
    ...typography.body,
    textAlign: 'center',
    marginTop: spacing.xs,
  },
  actions: {
    width: '100%',
    maxWidth: 340,
    gap: spacing.sm,
    marginTop: spacing.lg,
  },
});
