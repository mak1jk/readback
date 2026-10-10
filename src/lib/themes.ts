export type ThemeKey = 'nocturne' | 'graphite' | 'daylight';

export const THEMES: Record<ThemeKey, { name: string; v: Record<string, string> }> = {
  nocturne: { name: 'Nocturne', v: { bg: '#161826', fg: '#e9e9ed', 'fg-strong': '#f3f5fe', 'fg-2': '#e4e7f5', 'fg-3': '#cfd3e5', 'fg-4': '#b2b6ca', muted: '#9397ab', faint: '#75798c', dim: '#595d6c', 'line-2': '#3f424d', line: '#292b31', 'line-soft': '#1f2130', surface: '#232532', hover: '#1d1f2e', code: '#1b1d2b', accent: '#9184d9', 'accent-fg': '#b5abfc', 'accent-fg-2': '#d2cefd', 'accent-fg-3': '#e7e5fe', sel: '#423a6a', tint: '#2b2741', bar: '#5d5294', 'bar-2': '#796cbf', tool: 'oklch(0.72 0.08 200)', fail: 'oklch(0.7 0.13 25)', 'fail-bg': 'oklch(0.32 0.06 25)', 'fail-fg': 'oklch(0.86 0.07 25)', 'fail-text': 'oklch(0.78 0.11 25)', 'line-2-0': 'rgba(63,66,77,0)', overlay: 'rgba(22,24,38,0.92)' } },
  graphite: { name: 'Graphite', v: { bg: '#17181a', fg: '#ebebee', 'fg-strong': '#f5f5f7', 'fg-2': '#e3e4e8', 'fg-3': '#d0d1d6', 'fg-4': '#b6b7bd', muted: '#9a9ba2', faint: '#7a7b82', dim: '#5c5d63', 'line-2': '#404146', line: '#2c2d31', 'line-soft': '#212226', surface: '#232427', hover: '#1e1f22', code: '#1b1c1f', accent: 'oklch(0.76 0.11 75)', 'accent-fg': 'oklch(0.84 0.09 75)', 'accent-fg-2': 'oklch(0.9 0.06 75)', 'accent-fg-3': 'oklch(0.94 0.04 75)', sel: 'oklch(0.4 0.06 75)', tint: 'oklch(0.29 0.035 75)', bar: 'oklch(0.55 0.08 75)', 'bar-2': 'oklch(0.62 0.09 75)', tool: 'oklch(0.72 0.08 200)', fail: 'oklch(0.7 0.13 25)', 'fail-bg': 'oklch(0.32 0.06 25)', 'fail-fg': 'oklch(0.86 0.07 25)', 'fail-text': 'oklch(0.78 0.11 25)', 'line-2-0': 'rgba(64,65,70,0)', overlay: 'rgba(23,24,26,0.92)' } },
  daylight: { name: 'Daylight', v: { bg: '#f7f7f4', fg: '#1f1e1c', 'fg-strong': '#141412', 'fg-2': '#2a2926', 'fg-3': '#3d3c38', 'fg-4': '#55544f', muted: '#66655f', faint: '#7c7b75', dim: '#a3a29b', 'line-2': '#cfcec7', line: '#e2e1db', 'line-soft': '#ebeae4', surface: '#ecebe5', hover: '#f0efea', code: '#f1f0eb', accent: 'oklch(0.52 0.14 285)', 'accent-fg': 'oklch(0.47 0.15 285)', 'accent-fg-2': 'oklch(0.42 0.15 285)', 'accent-fg-3': 'oklch(0.36 0.14 285)', sel: 'oklch(0.88 0.05 285)', tint: 'oklch(0.93 0.03 285)', bar: 'oklch(0.72 0.08 285)', 'bar-2': 'oklch(0.6 0.12 285)', tool: 'oklch(0.55 0.09 200)', fail: 'oklch(0.6 0.15 25)', 'fail-bg': 'oklch(0.93 0.04 25)', 'fail-fg': 'oklch(0.45 0.14 25)', 'fail-text': 'oklch(0.52 0.15 25)', 'line-2-0': 'rgba(207,206,199,0)', overlay: 'rgba(247,247,244,0.92)' } },
};

// Syntax-highlight and diff tokens: one set for the dark themes, one for Daylight.
const SYN_D: Record<string, string> = { 'syn-kw': 'oklch(0.78 0.11 305)', 'syn-str': 'oklch(0.8 0.1 145)', 'syn-num': 'oklch(0.8 0.1 60)', 'syn-fn': 'oklch(0.8 0.09 245)', 'syn-type': 'oklch(0.8 0.08 190)', 'syn-dec': 'oklch(0.78 0.1 20)', 'add-bg': 'oklch(0.7 0.12 145 / 0.13)', 'del-bg': 'oklch(0.7 0.13 25 / 0.13)', 'add-fg': 'oklch(0.8 0.12 145)', 'del-fg': 'oklch(0.76 0.12 25)' };
const SYN_L: Record<string, string> = { 'syn-kw': 'oklch(0.5 0.15 305)', 'syn-str': 'oklch(0.5 0.13 145)', 'syn-num': 'oklch(0.52 0.13 60)', 'syn-fn': 'oklch(0.48 0.13 245)', 'syn-type': 'oklch(0.5 0.1 190)', 'syn-dec': 'oklch(0.5 0.14 20)', 'add-bg': 'oklch(0.7 0.12 145 / 0.16)', 'del-bg': 'oklch(0.7 0.13 25 / 0.16)', 'add-fg': 'oklch(0.48 0.13 145)', 'del-fg': 'oklch(0.5 0.15 25)' };

export const isThemeKey = (k: unknown): k is ThemeKey => typeof k === 'string' && k in THEMES;

export function applyTheme(k: ThemeKey) {
  const root = document.documentElement;
  Object.entries({ ...THEMES[k].v, ...(k === 'daylight' ? SYN_L : SYN_D) }).forEach(([n, c]) => root.style.setProperty('--' + n, c));
  root.style.colorScheme = k === 'daylight' ? 'light' : 'dark';
}
