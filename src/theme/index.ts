import { createContext, useContext } from 'react';
import type { TextStyle } from 'react-native';

/**
 * Prong visual system: direction 01 "Monospace Terminal".
 * One monospace grid, no radii, inverted selection (like a cursor), one amber accent that is both
 * "mode" and "current branch". Popups are frosted glass. Motion is near-instant.
 */


export interface Theme {
  name: SchemeId;
  bg: string;
  panel: string;
  panelAlt: string;
  raised: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentText: string;
  accentSoft: string;
  selection: string; // inverted block
  selectionText: string;
  softSelection: string; // non-inverted selection (sidebar, file lists)
  hover: string;
  add: string;
  addBg: string;
  del: string;
  delBg: string;
  warn: string;
  info: string;
  tag: string;
  remote: string;
  lanes: string[];
  mono: string;
  sans: string;
  glass: string; // frosted popup background
  glassBorder: string;
  glassHighlight: string;
  shadow: string;
  motion: number; // multiplier for animation durations
  fontFor: (weight?: TextStyle['fontWeight']) => string;
  kw: string;
  str: string;
  tagColor: string;
}

const FAMILY = {
  regular: 'JetBrainsMono_400Regular',
  medium: 'JetBrainsMono_500Medium',
  semibold: 'JetBrainsMono_600SemiBold',
  bold: 'JetBrainsMono_700Bold',
};
export const FONT_FAMILIES = FAMILY;

function fontFor(weight?: TextStyle['fontWeight']): string {
  const w = typeof weight === 'number' ? weight : weight === 'bold' ? 700 : parseInt(String(weight ?? '400'), 10) || 400;
  if (w >= 700) return FAMILY.bold;
  if (w >= 600) return FAMILY.semibold;
  if (w >= 500) return FAMILY.medium;
  return FAMILY.regular;
}

export type SchemeId = 'amber' | 'phosphor' | 'ice' | 'solar' | 'paper';
export type ThemeName = SchemeId;
export interface SchemeInfo {
  id: SchemeId;
  label: string;
  hint: string;
  dark: boolean;
}
export const SCHEMES: SchemeInfo[] = [
  { id: 'amber', label: 'Amber', hint: 'graphite · amber', dark: true },
  { id: 'phosphor', label: 'Phosphor', hint: 'black · phosphor green', dark: true },
  { id: 'ice', label: 'Ice', hint: 'slate · cyan', dark: true },
  { id: 'solar', label: 'Solar', hint: 'teal · solar yellow', dark: true },
  { id: 'paper', label: 'Paper', hint: 'paper · dark amber', dark: false },
];

interface Spec {
  name: SchemeId;
  bg: string; panel: string; panelAlt: string; raised: string; border: string; borderStrong: string;
  text: string; textMuted: string; textFaint: string;
  accent: string; accentText: string; selectionText: string;
  add: string; del: string; info: string; tag: string; lanes: string[];
  glass: string; glassBorder: string; glassHighlight: string; shadow: string; hover: string;
  kw: string; str: string; tagColor: string;
}

function rgba(hex: string, a: number) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function build(sp: Spec): Theme {
  return {
    name: sp.name,
    bg: sp.bg,
    panel: sp.panel,
    panelAlt: sp.panelAlt,
    raised: sp.raised,
    border: sp.border,
    borderStrong: sp.borderStrong,
    text: sp.text,
    textMuted: sp.textMuted,
    textFaint: sp.textFaint,
    accent: sp.accent,
    accentText: sp.accentText,
    accentSoft: rgba(sp.accent, 0.16),
    selection: sp.accent,
    selectionText: sp.selectionText,
    softSelection: sp.raised,
    hover: sp.hover,
    add: sp.add,
    addBg: rgba(sp.add, 0.12),
    del: sp.del,
    delBg: rgba(sp.del, 0.12),
    warn: sp.accent,
    info: sp.info,
    tag: sp.tag,
    remote: sp.textMuted,
    lanes: sp.lanes,
    mono: FAMILY.regular,
    sans: FAMILY.regular,
    glass: sp.glass,
    glassBorder: sp.glassBorder,
    glassHighlight: sp.glassHighlight,
    shadow: sp.shadow,
    motion: 0.5,
    fontFor,
    kw: sp.kw,
    str: sp.str,
    tagColor: sp.tagColor,
  };
}

const DARK_COMMON = { hover: 'rgba(255,255,255,0.045)', glassHighlight: 'rgba(255,255,255,0.06)', shadow: 'rgba(0,0,0,0.35)' };

export const amberTheme = build({
  name: 'amber', ...DARK_COMMON,
  bg: '#0f1113', panel: '#131619', panelAlt: '#171b1f', raised: '#1f2429', border: '#262c33', borderStrong: '#343c45',
  text: '#d9dee3', textMuted: '#8a949e', textFaint: '#596470',
  accent: '#e8b23b', accentText: '#15120a', selectionText: '#15120a',
  add: '#6ad48c', del: '#ff7369', info: '#5fcad8', tag: '#d7a1ff',
  lanes: ['#e8b23b', '#5fcad8', '#d7a1ff', '#6ad48c', '#6ea8ff', '#ff9a62'],
  glass: 'rgba(22,25,29,0.84)', glassBorder: 'rgba(217,222,227,0.14)',
  kw: '#ff9a62', str: '#5fcad8', tagColor: '#6ad48c',
});

export const phosphorTheme = build({
  name: 'phosphor', ...DARK_COMMON,
  bg: '#090c0a', panel: '#0d110e', panelAlt: '#111613', raised: '#18201a', border: '#1f2a22', borderStrong: '#2d3b31',
  text: '#cfe3d3', textMuted: '#7f9a86', textFaint: '#4f6656',
  accent: '#5fd18a', accentText: '#07120a', selectionText: '#07120a',
  add: '#8ff0ac', del: '#ff7a6b', info: '#7fd8e6', tag: '#e3c56a',
  lanes: ['#5fd18a', '#7fd8e6', '#e3c56a', '#c9a0ff', '#ff9a62', '#8fb3ff'],
  glass: 'rgba(12,17,14,0.84)', glassBorder: 'rgba(207,227,211,0.14)',
  kw: '#e3c56a', str: '#7fd8e6', tagColor: '#8ff0ac',
});

export const iceTheme = build({
  name: 'ice', ...DARK_COMMON,
  bg: '#0d1216', panel: '#11171c', panelAlt: '#151c22', raised: '#1d262e', border: '#243039', borderStrong: '#33424e',
  text: '#d6e2ec', textMuted: '#8aa0b2', textFaint: '#58707f',
  accent: '#5fcad8', accentText: '#071418', selectionText: '#071418',
  add: '#6ad48c', del: '#ff7a86', info: '#8fb3ff', tag: '#d7a1ff',
  lanes: ['#5fcad8', '#8fb3ff', '#d7a1ff', '#6ad48c', '#e8b23b', '#ff8fa3'],
  glass: 'rgba(17,23,28,0.84)', glassBorder: 'rgba(214,226,236,0.14)',
  kw: '#8fb3ff', str: '#6ad48c', tagColor: '#d7a1ff',
});

export const solarTheme = build({
  name: 'solar', ...DARK_COMMON,
  bg: '#00242e', panel: '#002b36', panelAlt: '#03313d', raised: '#073642', border: '#0c3f4b', borderStrong: '#1a4f5b',
  text: '#d9d2c2', textMuted: '#93a1a1', textFaint: '#586e75',
  accent: '#d9a400', accentText: '#1a1600', selectionText: '#1a1600',
  add: '#859900', del: '#dc322f', info: '#2aa198', tag: '#d33682',
  lanes: ['#d9a400', '#268bd2', '#d33682', '#859900', '#2aa198', '#cb4b16'],
  glass: 'rgba(0,43,54,0.84)', glassBorder: 'rgba(217,210,194,0.14)',
  kw: '#cb4b16', str: '#2aa198', tagColor: '#859900',
});

export const paperTheme = build({
  name: 'paper',
  hover: 'rgba(0,0,0,0.045)', glassHighlight: 'rgba(255,255,255,0.6)', shadow: 'rgba(0,0,0,0.2)',
  bg: '#f3f3f0', panel: '#fafaf7', panelAlt: '#efefeb', raised: '#e6e6e1', border: '#d9d9d3', borderStrong: '#bdbdb6',
  text: '#1d2126', textMuted: '#5f6872', textFaint: '#9aa3ab',
  accent: '#a86f08', accentText: '#fffaf0', selectionText: '#fffaf0',
  add: '#1f8a4c', del: '#c9372c', info: '#0e7c8a', tag: '#7a3fb8',
  lanes: ['#a86f08', '#0e7c8a', '#7a3fb8', '#1f8a4c', '#2358c9', '#c9552c'],
  glass: 'rgba(250,250,247,0.84)', glassBorder: 'rgba(29,33,38,0.14)',
  kw: '#c9552c', str: '#0e7c8a', tagColor: '#1f8a4c',
});

export const THEMES: Record<SchemeId, Theme> = { amber: amberTheme, phosphor: phosphorTheme, ice: iceTheme, solar: solarTheme, paper: paperTheme };
export const isDark = (id: SchemeId) => SCHEMES.find((s) => s.id === id)?.dark ?? true;
/** kept for older imports */
export const darkTheme = amberTheme;
export const lightTheme = paperTheme;

export const ThemeContext = createContext<Theme>(darkTheme);
export const useTheme = () => useContext(ThemeContext);

/** True while rendering inside an inverted (selected) row: text takes the selection foreground. */
export const SelectedContext = createContext(false);
export const useSelected = () => useContext(SelectedContext);

export const FONT = { xs: 10.5, sm: 11.5, md: 12, lg: 14, xl: 18 };
export const ROW = 22;
export const RADIUS = 0;
export const TOOLBAR_H = 36;
export const TABS_H = 32;
export const TRACK = 0.8; // letter-spacing for uppercase labels
export const UI_SCALES = [0.8, 0.9, 1, 1.1, 1.25, 1.5];
