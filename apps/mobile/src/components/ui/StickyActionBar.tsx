import type { PropsWithChildren } from 'react';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { colors, layout, spacing } from '../theme';

export const StickyActionBar = ({ children }: PropsWithChildren) => (
  <View style={styles.bar}>{children}</View>
);

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    minHeight: layout.stickyActionHeight,
    justifyContent: 'center',
    paddingHorizontal: layout.screenPadding,
    paddingVertical: spacing.base,
    backgroundColor: colors.background,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.outline,
    zIndex: 10,
  },
});
