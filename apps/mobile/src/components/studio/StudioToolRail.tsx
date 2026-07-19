import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { colors } from '../theme';

export type StudioTool = 'coach' | 'adjust' | 'looks' | 'ai' | 'more' | 'layers' | 'history';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

const tools: Array<{ id: StudioTool; label: string; icon: IconName }> = [
  { id: 'coach', label: 'Coach', icon: 'lightbulb-outline' },
  { id: 'adjust', label: 'Adjust', icon: 'tune-variant' },
  { id: 'looks', label: 'Looks', icon: 'palette-outline' },
  { id: 'ai', label: 'Generate', icon: 'creation-outline' },
  { id: 'more', label: 'More', icon: 'dots-horizontal' },
];

export const StudioToolRail = ({ active, onChange }: { active: StudioTool; onChange: (tool: StudioTool) => void }) => (
  <ScrollView
    horizontal
    showsHorizontalScrollIndicator={false}
    contentContainerStyle={styles.content}
    style={styles.rail}
  >
    {tools.map((tool) => {
      const selected = tool.id === active || (tool.id === 'more' && (active === 'layers' || active === 'history'));
      return (
        <Pressable
          key={tool.id}
          accessibilityRole="tab"
          accessibilityState={{ selected }}
          onPress={() => onChange(tool.id)}
          style={[styles.tool, selected && styles.toolSelected]}
        >
          <MaterialCommunityIcons name={tool.icon} size={20} color={selected ? colors.primary : colors.textSecondary} />
          <Text numberOfLines={1} style={[styles.label, selected && styles.labelSelected]}>{tool.label}</Text>
        </Pressable>
      );
    })}
  </ScrollView>
);

const styles = StyleSheet.create({
  rail: { flexGrow: 0, borderTopColor: colors.separator, borderTopWidth: StyleSheet.hairlineWidth, backgroundColor: colors.surface },
  content: { minWidth: '100%', paddingHorizontal: 4, alignItems: 'center', justifyContent: 'space-around' },
  tool: { minWidth: 62, minHeight: 60, gap: 3, paddingHorizontal: 8, alignItems: 'center', justifyContent: 'center', borderTopWidth: 2, borderTopColor: 'transparent' },
  toolSelected: { borderTopColor: colors.primary },
  label: { color: colors.textSecondary, fontSize: 11, fontWeight: '700' },
  labelSelected: { color: colors.text },
});
