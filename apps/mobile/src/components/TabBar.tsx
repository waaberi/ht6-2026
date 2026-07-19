import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, layout, spacing, typography } from './theme';

export type MainTab = 'camera' | 'library' | 'chat' | 'settings';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

const items: Array<{ id: MainTab; label: string; icon: IoniconName }> = [
  { id: 'camera', label: 'Camera', icon: 'camera-outline' },
  { id: 'library', label: 'Library', icon: 'images-outline' },
  { id: 'chat', label: 'Chat', icon: 'chatbubble-ellipses-outline' },
  { id: 'settings', label: 'Settings', icon: 'settings-outline' },
];

export const TabBar = ({ active, onChange }: { active: MainTab; onChange: (tab: MainTab) => void }) => {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, spacing.xs) }]}>
      {items.map((item) => {
        const selected = item.id === active;
        return (
          <Pressable
            key={item.id}
            onPress={() => onChange(item.id)}
            style={styles.item}
            accessibilityRole="tab"
            accessibilityLabel={item.label}
            accessibilityState={{ selected }}
          >
            <View style={styles.iconWrap}>
              <Ionicons
                name={item.icon}
                size={23}
                color={selected ? colors.primary : colors.textSecondary}
              />
            </View>
            <Text numberOfLines={1} style={[styles.label, selected && styles.selectedLabel]}>{item.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  bar: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.background,
    borderTopColor: colors.separator,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  item: {
    flex: 1,
    minHeight: layout.minTouchTarget,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  iconWrap: {
    width: 44,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { color: colors.textSecondary, ...typography.caption, fontWeight: '700' },
  selectedLabel: { color: colors.primary },
});
