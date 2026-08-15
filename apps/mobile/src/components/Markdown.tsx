import { View, useColorScheme } from 'react-native'
import { useMarkdown } from 'react-native-marked'
import type { Theme } from '../theme'

/** Markdown body for one chat message, themed for the containing bubble. */
export function MarkdownBody({ text, theme, inverse }: { text: string; theme: Theme; inverse: boolean }) {
  const colorScheme = useColorScheme()
  const base = inverse ? theme.userBubbleText : theme.assistantBubbleText
  const codeBase = inverse ? 'rgba(255,255,255,0.92)' : theme.codeText
  const elements = useMarkdown(text, {
    colorScheme,
    theme: {
      colors: { code: codeBase, link: inverse ? '#bfdbfe' : theme.accent, text: base, border: theme.border },
    },
    styles: {
      text: { color: base, fontSize: 15, lineHeight: 22 },
      paragraph: { marginVertical: 2 },
      link: { color: inverse ? '#bfdbfe' : theme.accent },
      codespan: {
        color: codeBase,
        backgroundColor: inverse ? 'rgba(255,255,255,0.18)' : theme.codeBg,
        borderRadius: 4,
        paddingHorizontal: 4,
      },
      code: {
        backgroundColor: inverse ? 'rgba(255,255,255,0.12)' : theme.codeBg,
        borderRadius: 8,
        padding: 10,
        marginVertical: 6,
      },
      blockquote: { borderLeftWidth: 3, borderLeftColor: theme.border, paddingLeft: 8, marginVertical: 4 },
      h1: { color: base, fontSize: 20, fontWeight: '700' },
      h2: { color: base, fontSize: 18, fontWeight: '700' },
      h3: { color: base, fontSize: 16, fontWeight: '600' },
      h4: { color: base, fontSize: 15, fontWeight: '600' },
      li: { color: base, fontSize: 15, lineHeight: 21 },
    },
  })
  return <View>{elements}</View>
}
