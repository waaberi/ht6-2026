import { MaterialCommunityIcons } from '@expo/vector-icons';
import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';

import { colors } from '../theme';

export type StudioTool = 'coach' | 'adjust' | 'transform' | 'looks' | 'ai' | 'layers' | 'history';

type IconName = React.ComponentProps<typeof MaterialCommunityIcons>['name'];

const tools: Array<{ id: StudioTool; label: string; icon: IconName }> = [
  { id: 'coach', label: 'Coach', icon: 'lightbulb-outline' },
  { id: 'adjust', label: 'Adjust', icon: 'tune-variant' },
  { id: 'transform', label: 'Crop', icon: 'crop-rotate' },
  { id: 'looks', label: 'Looks', icon: 'palette-outline' },
  { id: 'ai', label: 'AI', icon: 'creation-outline' },
  { id: 'layers', label: 'Layers', icon: 'layers-outline' },
  { id: 'history', label: 'History', icon: 'history' },
];

export const StudioToolRail = ({ active, onChange }: { active: StudioTool; onChange: (tool: StudioTool) => void }) => (
  <ScrollView
    horizontal
    showsHorizontalScrollIndicator={false}
    contentContainerStyle={styles.content}
    style={styles.rail}
  >
    {tools.map((tool) => {
      const selected = tool.id === active;
      return (
        <Pressable
          key={tool.id}
          accessibilityRole="tab"
          accessibilityState={{ selected }}
          onPress={() => onChange(tool.id)}
          style={({ pressed }) => [styles.tool, selected && styles.toolSelected, pressed && styles.pressed]}
        >
          <MaterialCommunityIcons name={tool.icon} size={20} color={selected ? colors.text : colors.textSecondary} />
          <Text style={[styles.label, selected && styles.labelSelected]}>{tool.label}</Text>
        </Pressable>
      );
    })}
  </ScrollView>
);

const styles = StyleSheet.create({
  rail: { flexGrow: 0, borderTopColor: colors.outline, borderTopWidth: StyleSheet.hairlineWidth, backgroundColor: colors.surface },
  content: { minWidth: '100%', paddingHorizontal: 4, alignItems: 'center' },
  tool: { minWidth: 70, minHeight: 60, gap: 3, paddingHorizontal: 10, alignItems: 'center', justifyContent: 'center', borderTopWidth: 2, borderTopColor: 'transparent' },
  toolSelected: { borderTopColor: colors.primary },
  label: { color: colors.textSecondary, fontSize: 11, fontWeight: '700' },
  labelSelected: { color: colors.text },
  pressed: { opacity: 0.72 },
});
