import { Platform, useColorScheme } from 'react-native'

/**
 * Semantic color tokens for the chat UI, mirroring the web GUI's --dsw-alias-*
 * vocabulary; light and dark palettes. Feature components consume these
 * aliases only — no literal colors in component files.
 */
export interface Theme {
  background: string
  surface: string
  surfaceMuted: string
  border: string
  text: string
  textMuted: string
  textInverse: string
  accent: string
  accentPressed: string
  accentSoft: string
  online: string
  danger: string
  dangerSoft: string
  warning: string
  warningBg: string
  warningText: string
  userBubble: string
  userBubbleText: string
  assistantBubble: string
  assistantBubbleText: string
  codeBg: string
  codeText: string
  bannerBg: string
  bannerText: string
  noticeBg: string
  noticeText: string
  inputBg: string
  separator: string
  overlay: string
}

const light: Theme = {
  background: '#ffffff',
  surface: '#ffffff',
  surfaceMuted: '#f6f8fa',
  border: '#d0d7de',
  text: '#111111',
  textMuted: '#666666',
  textInverse: '#ffffff',
  accent: '#2563eb',
  accentPressed: '#1d4ed8',
  accentSoft: '#eff6ff',
  online: '#15803d',
  danger: '#b91c1c',
  dangerSoft: '#fef2f2',
  warning: '#d97706',
  warningBg: '#fffbeb',
  warningText: '#92400e',
  userBubble: '#2563eb',
  userBubbleText: '#ffffff',
  assistantBubble: '#f3f4f6',
  assistantBubbleText: '#111111',
  codeBg: '#eef1f4',
  codeText: '#1f2328',
  bannerBg: '#fef2f2',
  bannerText: '#b91c1c',
  noticeBg: '#fffbeb',
  noticeText: '#92400e',
  inputBg: '#ffffff',
  separator: '#e5e7eb',
  overlay: 'rgba(0,0,0,0.45)',
}

const dark: Theme = {
  background: '#0d1117',
  surface: '#161b22',
  surfaceMuted: '#11151c',
  border: '#30363d',
  text: '#e6edf3',
  textMuted: '#8b949e',
  textInverse: '#ffffff',
  accent: '#3b82f6',
  accentPressed: '#2563eb',
  accentSoft: '#12233f',
  online: '#3fb950',
  danger: '#f85149',
  dangerSoft: '#2d1b1b',
  warning: '#e3b341',
  warningBg: '#2d2616',
  warningText: '#e3b341',
  userBubble: '#1f6feb',
  userBubbleText: '#ffffff',
  assistantBubble: '#161b22',
  assistantBubbleText: '#e6edf3',
  codeBg: '#1f2429',
  codeText: '#c9d1d9',
  bannerBg: '#2d1b1b',
  bannerText: '#f85149',
  noticeBg: '#2d2616',
  noticeText: '#e3b341',
  inputBg: '#161b22',
  separator: '#21262d',
  overlay: 'rgba(0,0,0,0.55)',
}

/** Resolve the active palette from the system color scheme. */
export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light
}

/** Shared layout constants: radii, monospace stack, and icon hit targets. */
export const metrics = {
  radiusSm: 8,
  radiusMd: 12,
  radiusLg: 16,
  radiusPill: 999,
  iconSize: 22,
  hitSlop: { top: 12, bottom: 12, left: 12, right: 12 },
  mono: Platform.select({ ios: 'Menlo', default: 'monospace' }),
}
