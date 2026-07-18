export const palette = {
  oxblood: '#221A1B',
  plum: '#493843',
  teal: '#61988E',
  sage: '#A0B2A6',
  blush: '#EABDA8',
} as const;

export const colors = {
  background: palette.oxblood,
  surface: 'rgba(73, 56, 67, 0.52)',
  surfaceStrong: palette.plum,
  primary: palette.blush,
  onPrimary: palette.oxblood,
  text: palette.blush,
  textSecondary: palette.sage,
  success: palette.teal,
  outline: 'rgba(160, 178, 166, 0.34)',
  outlineStrong: palette.sage,
  overlay: 'rgba(34, 26, 27, 0.78)',
  pressed: 'rgba(160, 178, 166, 0.14)',
  disabled: 'rgba(160, 178, 166, 0.38)',

  // Compatibility aliases while the remaining screens migrate to semantic roles.
  ink: palette.blush,
  muted: palette.sage,
  panel: 'rgba(73, 56, 67, 0.52)',
  panelRaised: 'rgba(73, 56, 67, 0.72)',
  canvas: palette.oxblood,
  line: 'rgba(160, 178, 166, 0.34)',
  lime: palette.blush,
  limeInk: palette.oxblood,
  amber: palette.blush,
  danger: palette.blush,
  white: '#FFFFFF',
} as const;

export const spacing = {
  xxs: 4,
  xs: 6,
  sm: 10,
  base: 12,
  md: 16,
  lg: 24,
  xl: 32,
} as const;

export const radii = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

export const typography = {
  displayFamily: 'ZenOldMincho_700Bold',
  display: { fontSize: 32, lineHeight: 40 },
  title: { fontSize: 24, lineHeight: 30 },
  section: { fontSize: 18, lineHeight: 24 },
  body: { fontSize: 16, lineHeight: 22 },
  label: { fontSize: 14, lineHeight: 18 },
  caption: { fontSize: 12, lineHeight: 16 },
} as const;

export const layout = {
  screenPadding: 20,
  minTouchTarget: 48,
  stickyActionHeight: 76,
} as const;
