import { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View, useColorScheme } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { Renderer, useMarkdown } from 'react-native-marked'
import type { ReactNode } from 'react'

import { metrics, type Theme } from '../theme'
import { AppIconCheckOutline16, AppIconCopyOutline16 } from './Icon'
import type { Translate } from '../i18n'

/** One block-code card: language label, copy button, and selectable body. */
function CodeBlock({ text, language, theme, t }: {
  text: string
  language: string | undefined
  theme: Theme
  t: Translate
}) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void Clipboard.setStringAsync(text).then(() => {
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1500)
    })
  }
  return (
    <View style={[styles.code, { backgroundColor: theme.codeBg, borderColor: theme.border }]}>
      <View style={styles.codeHead}>
        <Text style={[styles.codeLang, { color: theme.textMuted }]}>{language ?? ''}</Text>
        <Pressable onPress={copy} hitSlop={8} accessibilityLabel={t('copy')} accessibilityRole="button">
          {copied
            ? <AppIconCheckOutline16 size={15} color={theme.online} />
            : <AppIconCopyOutline16 size={15} color={theme.textMuted} />}
        </Pressable>
      </View>
      <Text style={[styles.codeBody, { color: theme.codeText }]} selectable>{text}</Text>
    </View>
  )
}

/** Default renderer with block code replaced by the copy-enabled card. */
class CopyCodeRenderer extends Renderer {
  override code(text: string, language?: string): ReactNode {
    return <CodeBlock key={this.getKey() + '-code'} text={text} language={language} theme={this.theme} t={this.t} />
  }

  constructor(private readonly theme: Theme, private readonly t: Translate) {
    super()
  }
}

/** Markdown body for one chat message, themed for the containing bubble. */
export function MarkdownBody({ text, theme, t, inverse }: {
  text: string
  theme: Theme
  t: Translate
  inverse: boolean
}) {
  const colorScheme = useColorScheme()
  const renderer = useMemo(() => new CopyCodeRenderer(theme, t), [theme, t])
  const base = inverse ? theme.userBubbleText : theme.assistantBubbleText
  const codeBase = inverse ? 'rgba(255,255,255,0.92)' : theme.codeText
  const elements = useMarkdown(text, {
    colorScheme,
    renderer,
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
        borderRadius: metrics.radiusMd,
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

const styles = StyleSheet.create({
  code: { borderRadius: metrics.radiusMd, borderWidth: StyleSheet.hairlineWidth, marginVertical: 6, gap: 2 },
  codeHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 10, paddingTop: 6,
  },
  codeLang: { fontSize: 11, fontFamily: metrics.mono },
  codeBody: {
    fontSize: 13, fontFamily: metrics.mono, lineHeight: 18,
    paddingHorizontal: 10, paddingBottom: 10,
  },
})
