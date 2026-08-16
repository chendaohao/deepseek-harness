import { useEffect, useRef, useState } from 'react'
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
              <MessageImage key={image.attachmentId + String(index)} attachment={image} theme={theme} t={t} loadImage={loadImage} />
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

/** One durable image attachment, downloaded once per id; a failed load stays failed for the row's lifetime. */
function MessageImage({ attachment, theme, t, loadImage }: {
  attachment: ImageAttachmentRef
  theme: Theme
  t: Translate
  loadImage(attachmentId: string): Promise<string | null>
}) {
  const [uri, setUri] = useState<string | null>(() => imageCache.get(attachment.attachmentId) ?? null)
  const [failed, setFailed] = useState(false)
  // The parent re-renders on every snapshot publish and recreates its inline
  // loader closure; the ref keeps this effect anchored to the attachment id
  // alone, so one row downloads exactly once instead of once per render (a
  // failure loop would otherwise retry the round trip forever).
  const loaderRef = useRef(loadImage)
  loaderRef.current = loadImage
  useEffect(() => {
    if (uri !== null || failed) return
    let alive = true
    void loaderRef.current(attachment.attachmentId).then((data) => {
      if (!alive) return
      if (data !== null) {
        imageCache.set(attachment.attachmentId, data)
        setUri(data)
      } else {
        setFailed(true)
      }
    })
    return () => { alive = false }
  }, [attachment.attachmentId, uri, failed])
  if (uri === null) {
    return (
      <View style={[styles.imageLoading, { backgroundColor: theme.codeBg }]}>
        {failed
          ? <Text style={[styles.imageFailed, { color: theme.textMuted }]}>{t('imageLoadFailed')}</Text>
          : <ActivityIndicator color={theme.accent} />}
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
  imageFailed: { fontSize: 12, paddingHorizontal: 12, textAlign: 'center' },
})
