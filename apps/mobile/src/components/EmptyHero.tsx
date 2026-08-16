import { Image, Pressable, StyleSheet, Text, View } from 'react-native'
import { metrics, type Theme } from '../theme'
import type { Translate } from '../i18n'

/** Empty-conversation hero: the app mark, a greeting, and starter prompts. */
export function EmptyHero({ prompts, theme, t, onPrompt }: {
  prompts: readonly string[]
  theme: Theme
  t: Translate
  onPrompt(text: string): void
}) {
  return (
    <View style={styles.root}>
      {/* oxlint-disable-next-line typescript/no-require-imports -- RN static assets load through Metro's require() */}
      <Image source={require('../../assets/icon.png')} style={styles.mark} />
      <Text style={[styles.greeting, { color: theme.text }]}>{t('emptyHeroTitle')}</Text>
      <View style={styles.chips}>
        {prompts.map(prompt => (
          <Pressable
            key={prompt}
            style={({ pressed }) => [
              styles.chip,
              { borderColor: theme.border, backgroundColor: theme.surface },
              pressed ? { backgroundColor: theme.accentSoft, borderColor: theme.accent } : null,
            ]}
            onPress={() => { onPrompt(prompt) }}
            accessibilityRole="button"
            accessibilityLabel={prompt}
          >
            <Text style={[styles.chipText, { color: theme.text }]}>{prompt}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', marginTop: 96, paddingHorizontal: 24, gap: 16 },
  mark: { width: 64, height: 64, borderRadius: metrics.radiusLg },
  greeting: { fontSize: 20, fontWeight: '600' },
  chips: { alignSelf: 'stretch', gap: 8 },
  chip: {
    borderRadius: metrics.radiusMd, borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14, paddingVertical: 12,
  },
  chipText: { fontSize: 14 },
})
