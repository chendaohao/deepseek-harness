import { useEffect, useState } from 'react'
import { ActivityIndicator, Alert, Image, Pressable, Share, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ChatMessage } from '@deepseek-ai/dsh-client-mobile'
import { metrics, type Theme } from '../theme'
import type { Translate } from '../i18n'
import { MarkdownBody } from './Markdown'

/** Downloaded-image cache keyed by attachment id (a refetch costs a round trip). */
const imageCache = new Map<string, string>()

/** One conversation message: user bubble right, assistant bubble left. */
export function MessageBubble({ message, theme, t, loadImage }: {
  message: ChatMessage
  theme: Theme
  t: Translate
  loadImage(attachmentId: string): Promise<string | null>
}) {
  const mine = message.kind === 'user'
  const onLongPress = (): void => {
    Alert.alert('', undefined, [
      {
        text: t('copy'),
        onPress: () => { void Clipboard.setStringAsync(message.text) },
      },
      {
        text: t('share'),
        onPress: () => { void Share.share({ message: message.text }) },
      },
      { text: t('cancel'), style: 'cancel' },
    ])
  }
  return (
    <View style={[styles.wrap, mine ? styles.wrapMine : styles.wrapTheirs]}>
      {!mine ? <Text style={[styles.roleLabel, { color: theme.textMuted }]}>{t('agentLabel')}</Text> : null}
      <Pressable
        style={({ pressed }) => [
          styles.bubble,
          { backgroundColor: mine ? theme.userBubble : theme.assistantBubble },
          pressed ? styles.bubblePressed : null,
        ]}
        onLongPress={onLongPress}
        delayLongPress={400}
      >
        {message.kind === 'user' && message.images.length > 0 ? (
          <View style={styles.images}>
            {message.images.map((image, index) => (
              <MessageImage key={image.attachmentId + String(index)} attachment={image} theme={theme} loadImage={loadImage} />
            ))}
          </View>
        ) : null}
        {message.text !== '' ? <MarkdownBody text={message.text} theme={theme} t={t} inverse={mine} /> : null}
        {message.kind === 'assistant' && !message.complete ? (
          <Text style={[styles.typing, { color: theme.textMuted }]}>…</Text>
        ) : null}
      </Pressable>
    </View>
  )
}

/** One durable image attachment, downloaded once and cached per id. */
function MessageImage({ attachment, theme, loadImage }: {
  attachment: ImageAttachmentRef
  theme: Theme
  loadImage(attachmentId: string): Promise<string | null>
}) {
  const [uri, setUri] = useState<string | null>(() => imageCache.get(attachment.attachmentId) ?? null)
  useEffect(() => {
    let alive = true
    void loadImage(attachment.attachmentId).then((data) => {
      if (alive && data !== null) {
        imageCache.set(attachment.attachmentId, data)
        setUri(data)
      }
    })
    return () => { alive = false }
  }, [attachment.attachmentId, loadImage])
  if (uri === null) {
    return (
      <View style={[styles.imageLoading, { backgroundColor: theme.codeBg }]}>
        <ActivityIndicator color={theme.accent} />
      </View>
    )
  }
  return <Image source={{ uri }} style={styles.image} resizeMode="cover" />
}

const styles = StyleSheet.create({
  wrap: { marginVertical: 4, maxWidth: '85%' },
  wrapMine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  wrapTheirs: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  roleLabel: { fontSize: 11, marginBottom: 2, marginLeft: 4 },
  bubble: { borderRadius: metrics.radiusLg, paddingHorizontal: 14, paddingVertical: 10 },
  bubblePressed: { opacity: 0.85 },
  typing: { marginTop: 2 },
  images: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  image: { width: 180, height: 180, borderRadius: metrics.radiusMd },
  imageLoading: {
    width: 180, height: 180, borderRadius: metrics.radiusMd,
    alignItems: 'center', justifyContent: 'center',
  },
})
