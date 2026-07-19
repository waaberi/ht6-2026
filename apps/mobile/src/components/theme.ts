export const palette = {
  oxblood: '#221A1B',
  plum: '#493843',
  teal: '#61988E',
  sage: '#A0B2A6',
  blush: '#EABDA8',
} as const;

export const colors = {
  background: palette.oxblood,
  surface: palette.plum,
  surfaceStrong: '#58434F',
  surfaceRaised: '#624A58',
  controlSurface: '#58434F',
  controlPressed: '#624A58',
  primary: palette.teal,
  primaryPressed: '#78AAA1',
  onPrimary: palette.oxblood,
  onControlSurface: palette.blush,
  actionText: palette.blush,
  text: palette.blush,
  textSecondary: palette.sage,
  success: palette.teal,
  onSuccess: palette.oxblood,
  info: palette.sage,
  warning: '#E6C978',
  onWarning: palette.oxblood,
  error: '#FFB4AB',
  onError: palette.oxblood,
  outline: 'rgba(160, 178, 166, 0.72)',
  outlineStrong: palette.sage,
  separator: 'rgba(160, 178, 166, 0.34)',
  overlay: 'rgba(34, 26, 27, 0.78)',
  pressed: 'rgba(160, 178, 166, 0.14)',
  disabled: 'rgba(160, 178, 166, 0.38)',

  // Deprecated compatibility aliases. New UI must use the semantic roles above.
  ink: palette.blush,
  muted: palette.sage,
  panel: palette.plum,
  panelRaised: '#58434F',
  canvas: palette.oxblood,
  line: 'rgba(160, 178, 166, 0.34)',
  lime: palette.teal,
  limeInk: palette.oxblood,
  amber: '#E6C978',
  danger: '#FFB4AB',
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
  formMaxWidth: 480,
  readingMaxWidth: 720,
  screenMaxWidth: 1200,
} as const;
