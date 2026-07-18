import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors } from './theme';

export type MainTab = 'camera' | 'library' | 'portfolio' | 'looks' | 'settings';

const items: Array<{ id: MainTab; label: string; glyph: string }> = [
  { id: 'camera', label: 'Camera', glyph: '◎' },
  { id: 'library', label: 'Library', glyph: '▦' },
  { id: 'portfolio', label: 'Portfolio', glyph: '◇' },
  { id: 'looks', label: 'Looks', glyph: '◐' },
  { id: 'settings', label: 'Settings', glyph: '⚙' },
];

export const TabBar = ({ active, onChange }: { active: MainTab; onChange: (tab: MainTab) => void }) => (
  <View style={styles.bar}>
    {items.map((item) => {
      const selected = item.id === active;
      return (
        <Pressable
          key={item.id}
          onPress={() => onChange(item.id)}
          style={styles.item}
          accessibilityRole="tab"
          accessibilityState={{ selected }}
        >
          <Text style={[styles.glyph, selected && styles.selected]}>{item.glyph}</Text>
          <Text style={[styles.label, selected && styles.selected]}>{item.label}</Text>
        </Pressable>
      );
    })}
  </View>
);

const styles = StyleSheet.create({
  bar: {
    minHeight: 70,
    paddingBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.panel,
    borderTopColor: colors.line,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  item: { flex: 1, minHeight: 54, alignItems: 'center', justifyContent: 'center', gap: 2 },
  glyph: { color: colors.muted, fontSize: 20 },
  label: { color: colors.muted, fontSize: 10, letterSpacing: 0.2 },
  selected: { color: colors.lime },
});
