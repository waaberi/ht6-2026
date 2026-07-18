import { Ionicons } from '@expo/vector-icons';
import type { ComponentProps } from 'react';
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors, layout, spacing, typography } from './theme';

export type MainTab = 'camera' | 'library' | 'settings';

type IoniconName = ComponentProps<typeof Ionicons>['name'];

const items: Array<{ id: MainTab; label: string; icon: IoniconName; activeIcon: IoniconName }> = [
  { id: 'camera', label: 'Camera', icon: 'camera-outline', activeIcon: 'camera' },
  { id: 'library', label: 'Library', icon: 'images-outline', activeIcon: 'images' },
  { id: 'settings', label: 'Settings', icon: 'settings-outline', activeIcon: 'settings' },
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
            style={({ pressed }) => [styles.item, pressed && styles.pressed]}
            accessibilityRole="tab"
            accessibilityLabel={item.label}
            accessibilityState={{ selected }}
          >
            <View style={styles.iconWrap}>
              <Ionicons
                name={selected ? item.activeIcon : item.icon}
                size={23}
                color={selected ? colors.primary : colors.textSecondary}
              />
            </View>
            <Text style={[styles.label, selected && styles.selectedLabel]}>{item.label}</Text>
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
    backgroundColor: 'rgba(34, 26, 27, 0.98)',
    borderTopColor: colors.outline,
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
  label: { color: colors.textSecondary, ...typography.caption, fontWeight: '600' },
  selectedLabel: { color: colors.primary, fontWeight: '700' },
  pressed: { opacity: 0.72 },
});
