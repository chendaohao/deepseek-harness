import { useColorScheme } from 'react-native'

/** Semantic color tokens for the chat UI; light and dark palettes. */
export interface Theme {
  background: string
  surface: string
  border: string
  text: string
  textMuted: string
  textInverse: string
  accent: string
  accentPressed: string
  online: string
  danger: string
  userBubble: string
  userBubbleText: string
  assistantBubble: string
  assistantBubbleText: string
  codeBg: string
  codeText: string
  toolBg: string
  toolBorder: string
  bannerBg: string
  bannerText: string
  noticeBg: string
  noticeText: string
  inputBg: string
  separator: string
}

const light: Theme = {
  background: '#ffffff',
  surface: '#ffffff',
  border: '#d0d7de',
  text: '#111111',
  textMuted: '#666666',
  textInverse: '#ffffff',
  accent: '#2563eb',
  accentPressed: '#1d4ed8',
  online: '#15803d',
  danger: '#b91c1c',
  userBubble: '#2563eb',
  userBubbleText: '#ffffff',
  assistantBubble: '#f3f4f6',
  assistantBubbleText: '#111111',
  codeBg: '#eef1f4',
  codeText: '#1f2328',
  toolBg: '#f8fafc',
  toolBorder: '#e2e8f0',
  bannerBg: '#fef2f2',
  bannerText: '#b91c1c',
  noticeBg: '#fffbeb',
  noticeText: '#92400e',
  inputBg: '#ffffff',
  separator: '#e5e7eb',
}

const dark: Theme = {
  background: '#0d1117',
  surface: '#161b22',
  border: '#30363d',
  text: '#e6edf3',
  textMuted: '#8b949e',
  textInverse: '#ffffff',
  accent: '#3b82f6',
  accentPressed: '#2563eb',
  online: '#3fb950',
  danger: '#f85149',
  userBubble: '#1f6feb',
  userBubbleText: '#ffffff',
  assistantBubble: '#161b22',
  assistantBubbleText: '#e6edf3',
  codeBg: '#1f2429',
  codeText: '#c9d1d9',
  toolBg: '#161b22',
  toolBorder: '#30363d',
  bannerBg: '#2d1b1b',
  bannerText: '#f85149',
  noticeBg: '#2d2616',
  noticeText: '#e3b341',
  inputBg: '#161b22',
  separator: '#21262d',
}

/** Resolve the active palette from the system color scheme. */
export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light
}
