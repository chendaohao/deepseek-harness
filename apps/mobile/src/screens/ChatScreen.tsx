import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator, Animated, Alert, FlatList, Image, KeyboardAvoidingView, Platform,
  Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as Haptics from 'expo-haptics'
import * as ImageManipulator from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import type {
  ConnectionStatus, PairingRecord, PromptPart, SessionSummary, ToolStatusLine,
} from '@deepseek-ai/dsh-client-mobile'
import { useVoiceController } from '../use-voice-controller'
import { useTheme, metrics, type Theme } from '../theme'
import { useI18n, type I18nKey } from '../i18n'
import { MessageBubble } from '../components/MessageBubble'
import { ToolRow } from '../components/ToolRow'
import { ApprovalCard, PlanBanner, QuestionCard, TodoPanel } from '../components/ChatPanels'
import { EmptyHero } from '../components/EmptyHero'
import { SessionsDrawer } from '../components/SessionsDrawer'
import { SettingsSheet } from '../components/SettingsSheet'
import {
  AppIconChevronDownOutline14, AppIconMic, AppIconNewChatOutline16,
  AppIconPaperclipOutline16, AppIconSendOutline16, AppIconSettingsOutline16, AppIconStopFill16,
} from '../components/Icon'

const CONNECTION_LABELS: Record<ConnectionStatus, I18nKey> = {
  connecting: 'connecting',
  online: 'online',
  reconnecting: 'reconnecting',
  needsPairing: 'needsPairing',
  failed: 'failed',
}

/** One picked draft image: local uri for the rail, base64 data for the wire. */
interface DraftImage {
  readonly uri: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  readonly data: string
  readonly name?: string
}

/** One row of the conversation flow: a chat message or an inline tool row. */
type TimelineItem =
  | { readonly kind: 'message'; readonly key: string; readonly message: ChatMessageLike }
  | { readonly kind: 'tool'; readonly key: string; readonly line: ToolStatusLine }

/** Message shape re-exported through the timeline (kind union from the core). */
type ChatMessageLike = Parameters<typeof MessageBubble>[0]['message']

/** Distance from the list bottom under which auto-scroll stays armed. */
const NEAR_BOTTOM_THRESHOLD = 96

const CONNECTION_DOT: Record<ConnectionStatus, keyof Theme> = {
  connecting: 'warning',
  online: 'online',
  reconnecting: 'warning',
  needsPairing: 'danger',
  failed: 'danger',
}

/** The paired host chat screen: voice conversation with text and image input. */
export function ChatScreen({ record, onRepair }: { record: PairingRecord; onRepair(): void }) {
  const { controller, snapshot } = useVoiceController(record)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftImages, setDraftImages] = useState<DraftImage[]>([])
  const [sessionTitle, setSessionTitle] = useState<string | null>(null)
  const [nearBottom, setNearBottom] = useState(true)
  const nearBottomRef = useRef(true)
  const listRef = useRef<FlatList<TimelineItem>>(null)
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { t, quickPrompts } = useI18n()
  const sessionId = snapshot?.sessionId ?? ''

  // Auto-scroll only while the user sits near the bottom; scrolling up pins
  // the view and swaps the auto-scroll for the back-to-bottom affordance.
  const scrollToEnd = useCallback(() => {
    nearBottomRef.current = true
    setNearBottom(true)
    void listRef.current?.scrollToEnd({ animated: true })
  }, [])

  const onScroll = useCallback((
    event: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } },
  ) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent
    const distance = contentSize.height - contentOffset.y - layoutMeasurement.height
    const near = distance < NEAR_BOTTOM_THRESHOLD
    if (near !== nearBottomRef.current) {
      nearBottomRef.current = near
      setNearBottom(near)
    }
  }, [])

  useEffect(() => {
    if (snapshot !== null && nearBottomRef.current) {
      void listRef.current?.scrollToEnd({ animated: true })
    }
  }, [snapshot?.messages.length, snapshot?.toolLines.length, snapshot?.turnRunning])

  // The header shows the current session's list title; refresh per switch.
  useEffect(() => {
    if (controller === null || sessionId === '') return
    let alive = true
    void controller.listSessions().then((list) => {
      if (!alive) return
      const current = list.find((session: SessionSummary) => session.sessionId === sessionId)
      setSessionTitle(current?.title ?? null)
    }).catch(() => undefined)
    return () => { alive = false }
  }, [controller, sessionId])

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...snapshot === null ? [] : snapshot.messages.map(message => ({
        kind: 'message' as const,
        key: 'm-' + message.kind + '-' + String(message.seq),
        message,
      })),
      ...snapshot === null ? [] : snapshot.toolLines.map(line => ({ kind: 'tool' as const, key: 't-' + line.id, line })),
    ]
    items.sort((a, b) => {
      const seqA = a.kind === 'message' ? a.message.seq : a.line.seq
      const seqB = b.kind === 'message' ? b.message.seq : b.line.seq
      if (seqA !== seqB) return seqA - seqB
      return a.kind === 'message' ? -1 : 1
    })
    return items
  }, [snapshot?.messages, snapshot?.toolLines])

  // The gated command for the approval card: join the frame's callId with the
  // matching tool row (the same join the web ApprovalPanel performs).
  const approvalCommand = useMemo(() => {
    const approval = snapshot?.pendingApproval
    if (approval?.callId === undefined) return undefined
    const line = snapshot?.toolLines.find(entry => entry.id === approval.callId)
    if (line === undefined) return undefined
    try {
      const args = JSON.parse(line.argumentsText) as Record<string, unknown>
      return typeof args.command === 'string' && args.command !== '' ? args.command : undefined
    } catch {
      return undefined
    }
  }, [snapshot?.pendingApproval, snapshot?.toolLines])

  if (snapshot === null || controller === null) {
    return (
      <View style={[styles.center, { backgroundColor: theme.background, paddingTop: insets.top }]}>
        <ActivityIndicator size="large" color={theme.accent} />
        <Text style={{ color: theme.textMuted }}>{t('connecting')}</Text>
      </View>
    )
  }

  const pickImage = async (source: 'camera' | 'library'): Promise<void> => {
    const permission = source === 'camera'
      ? await ImagePicker.requestCameraPermissionsAsync()
      : await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!permission.granted) {
      Alert.alert(t('attachImage'), t('photoPermissionDenied'))
      return
    }
    const picked = source === 'camera'
      ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 })
      : await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 1 })
    if (picked.canceled) return
    const asset = picked.assets[0]
    if (asset === undefined) return
    // Resize + compress + base64 in one pass; JPEG keeps the payload small.
    const edited = await ImageManipulator.manipulateAsync(
      asset.uri,
      [{ resize: { width: 1600 } }],
      { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG, base64: true },
    )
    const base64 = edited.base64
    if (base64 === undefined || base64 === '') return
    setDraftImages(previous => [...previous, {
      uri: edited.uri,
      mediaType: 'image/jpeg',
      data: base64,
      ...(asset.fileName == null ? {} : { name: asset.fileName }),
    }])
  }

  const attachPress = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    Alert.alert(t('attachImage'), undefined, [
      { text: t('camera'), onPress: () => { void pickImage('camera') } },
      { text: t('library'), onPress: () => { void pickImage('library') } },
      { text: t('cancel'), style: 'cancel' },
    ])
  }

  const sendDraft = (): void => {
    const parts: PromptPart[] = [
      ...draftImages.map(image => ({
        type: 'image' as const,
        mediaType: image.mediaType,
        data: image.data,
        ...(image.name === undefined ? {} : { name: image.name }),
      })),
      ...(draft.trim() === '' ? [] : [{ type: 'text' as const, text: draft }]),
    ]
    if (parts.length === 0) return
    controller.submitContent(parts)
    setDraft('')
    setDraftImages([])
    scrollToEnd()
  }

  const canSend = draft.trim() !== '' || draftImages.length > 0
  const listening = snapshot.listener === 'listening'
  const busy = snapshot.listener === 'processing' || snapshot.turnRunning || snapshot.speaking

  const statusHint: I18nKey | null = listening
    ? 'micHintListening'
    : snapshot.listener === 'processing'
      ? 'micHintProcessing'
      : snapshot.turnRunning || snapshot.speaking
        ? 'micHintWorking'
        : null

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={[
        styles.header,
        { paddingTop: insets.top + 6, borderColor: theme.separator, borderBottomWidth: StyleSheet.hairlineWidth },
      ]}>
        <Pressable
          style={styles.headerTitleWrap}
          onPress={() => { setSessionsOpen(true) }}
          accessibilityRole="button"
          accessibilityLabel={t('sessions')}
        >
          <Text style={[styles.headerTitle, { color: theme.text }]} numberOfLines={1}>
            {sessionTitle ?? t('title')}
          </Text>
          <View style={[styles.statusChip, { borderColor: theme.border }]}>
            <View style={[styles.statusDot, { backgroundColor: theme[CONNECTION_DOT[snapshot.connection]] }]} />
            <Text style={[styles.statusChipText, { color: theme.textMuted }]}>
              {t(CONNECTION_LABELS[snapshot.connection])}
            </Text>
          </View>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.headerIcon, pressed ? { opacity: 0.6 } : null]}
          onPress={() => { setSessionsOpen(true) }}
          hitSlop={metrics.hitSlop}
          accessibilityRole="button"
          accessibilityLabel={t('newSession')}
        >
          <AppIconNewChatOutline16 size={metrics.iconSize} color={theme.textMuted} />
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.headerIcon, pressed ? { opacity: 0.6 } : null]}
          onPress={() => { setSettingsOpen(true) }}
          hitSlop={metrics.hitSlop}
          accessibilityRole="button"
          accessibilityLabel={t('settings')}
        >
          <AppIconSettingsOutline16 size={metrics.iconSize} color={theme.textMuted} />
        </Pressable>
      </View>

      {snapshot.connection === 'needsPairing' || snapshot.connection === 'failed' ? (
        <View style={[styles.banner, { backgroundColor: theme.bannerBg }]}>
          <Text style={[styles.bannerText, { color: theme.bannerText }]}>
            {snapshot.connection === 'needsPairing' ? t('pairingExpired') : t('connectionLost')}
          </Text>
          <Pressable
            style={({ pressed }) => [
              styles.bannerButton,
              { backgroundColor: pressed ? theme.accentPressed : theme.danger },
            ]}
            onPress={() => {
              if (snapshot.connection === 'needsPairing') onRepair()
              else controller.reconnect()
            }}
            accessibilityRole="button"
          >
            <Text style={[styles.bannerButtonText, { color: theme.textInverse }]}>
              {snapshot.connection === 'needsPairing' ? t('repair') : t('retry')}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {snapshot.notice !== null ? (
        <Pressable style={[styles.notice, { backgroundColor: theme.noticeBg }]} onPress={() => { controller.acknowledgeNotice() }}>
          <Text style={[styles.noticeText, { color: theme.noticeText }]} numberOfLines={2}>{snapshot.notice}</Text>
        </Pressable>
      ) : null}

      <View style={styles.listWrap}>
        <FlatList
          ref={listRef}
          style={styles.list}
          data={timeline}
          keyExtractor={item => item.key}
          renderItem={({ item }) => item.kind === 'message'
            ? <MessageBubble message={item.message} theme={theme} t={t} loadImage={id => controller.downloadImage(id)} />
            : <ToolRow line={item.line} theme={theme} t={t} />}
          ListEmptyComponent={(
            <EmptyHero
              prompts={quickPrompts}
              theme={theme}
              t={t}
              onPrompt={(prompt) => {
                controller.submitText(prompt)
                scrollToEnd()
              }}
            />
          )}
          onScroll={onScroll}
          onContentSizeChange={() => {
            if (nearBottomRef.current) void listRef.current?.scrollToEnd({ animated: true })
          }}
          scrollEventThrottle={32}
        />
        {!nearBottom ? (
          <Pressable
            style={({ pressed }) => [
              styles.backToBottom,
              { backgroundColor: theme.surface, borderColor: theme.border },
              pressed ? { opacity: 0.8 } : null,
            ]}
            onPress={scrollToEnd}
            accessibilityRole="button"
            accessibilityLabel={t('backToBottom')}
          >
            <AppIconChevronDownOutline14 size={18} color={theme.textMuted} />
          </Pressable>
        ) : null}
      </View>

      {snapshot.pendingApproval !== null ? (
        <ApprovalCard
          approval={snapshot.pendingApproval}
          command={approvalCommand}
          // The card renders only while pendingApproval is non-null.
          // oxlint-disable-next-line typescript/no-non-null-assertion
          onAnswer={(outcome) => { controller.answerApproval(snapshot.pendingApproval!.approvalId, outcome) }}
          theme={theme}
          t={t}
        />
      ) : null}

      {snapshot.pendingQuestion !== null ? (
        <QuestionCard
          question={snapshot.pendingQuestion}
          // The card renders only while pendingQuestion is non-null.
          // oxlint-disable-next-line typescript/no-non-null-assertion
          onAnswer={(answers) => { controller.answerQuestion(snapshot.pendingQuestion!.questionRpcId, answers) }}
          theme={theme}
          t={t}
        />
      ) : null}

      {snapshot.planActive ? <PlanBanner theme={theme} t={t} /> : null}

      {snapshot.todos.length > 0 ? <TodoPanel todos={snapshot.todos} theme={theme} t={t} /> : null}

      {snapshot.interim !== '' ? (
        <Text style={[styles.interim, { color: theme.textMuted }]} numberOfLines={2}>{snapshot.interim}</Text>
      ) : null}

      <View style={[styles.composer, { borderTopColor: theme.separator, paddingBottom: insets.bottom + 6 }]}>
        {statusHint !== null ? (
          <Text style={[styles.statusHint, { color: theme.textMuted }]}>{t(statusHint)}</Text>
        ) : null}
        {draftImages.length > 0 ? (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.imageRail}
            contentContainerStyle={styles.imageRailContent}
          >
            {draftImages.map((image, index) => (
              <View key={index} style={styles.imageRailItem}>
                <Image source={{ uri: image.uri }} style={styles.imageRailThumb} />
                <Pressable
                  style={({ pressed }) => [styles.imageRailRemove, pressed ? { opacity: 0.7 } : null]}
                  onPress={() => { setDraftImages(previous => previous.filter((_, i) => i !== index)) }}
                  accessibilityRole="button"
                  accessibilityLabel={t('cancel')}
                >
                  <Text style={styles.imageRailRemoveText}>×</Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        ) : null}
        <View style={styles.composerRow}>
          <Pressable
            style={({ pressed }) => [
              styles.attachButton,
              { borderColor: theme.border },
              pressed ? { backgroundColor: theme.surfaceMuted } : null,
            ]}
            onPress={attachPress}
            accessibilityRole="button"
            accessibilityLabel={t('attachImage')}
          >
            <AppIconPaperclipOutline16 size={19} color={theme.textMuted} />
          </Pressable>
          <TextInput
            style={[styles.input, { backgroundColor: theme.inputBg, borderColor: theme.border, color: theme.text }]}
            value={draft}
            onChangeText={setDraft}
            placeholder={t('inputPlaceholder')}
            placeholderTextColor={theme.textMuted}
            multiline
          />
          {canSend ? (
            <Pressable
              style={({ pressed }) => [
                styles.sendButton,
                { backgroundColor: pressed ? theme.accentPressed : theme.accent },
              ]}
              onPress={sendDraft}
              accessibilityRole="button"
              accessibilityLabel={t('send')}
            >
              <AppIconSendOutline16 size={19} color={theme.textInverse} />
            </Pressable>
          ) : null}
          <MicButton
            theme={theme}
            listening={listening}
            busy={busy}
            onPressIn={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
              if (snapshot.listener === 'idle' && !snapshot.turnRunning) controller.startListening()
            }}
            onPressOut={() => {
              if (snapshot.listener === 'listening') controller.stopListening()
            }}
            onTap={() => {
              if (snapshot.listener === 'processing' || snapshot.turnRunning || snapshot.speaking) {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
                controller.stopSpeaking()
                if (snapshot.turnRunning) void controller.cancelTurn()
              }
            }}
            label={listening ? t('micHintListening') : busy ? t('stopAgent') : t('micHintIdle')}
          />
        </View>
      </View>

      <SessionsDrawer
        visible={sessionsOpen}
        controller={controller}
        currentSessionId={snapshot.sessionId}
        theme={theme}
        t={t}
        onClose={() => { setSessionsOpen(false) }}
      />

      <SettingsSheet
        visible={settingsOpen}
        snapshot={snapshot}
        controller={controller}
        host={record.baseUrl}
        theme={theme}
        t={t}
        onClose={() => { setSettingsOpen(false) }}
        onLanguage={(language) => { controller.setLanguage(language) }}
        onAutoSpeak={(enabled) => { controller.setAutoSpeak(enabled) }}
        onAutoListen={(enabled) => { controller.setAutoListen(enabled) }}
        onTtsRate={(rate) => { controller.setTtsRate(rate) }}
        onTtsPitch={(pitch) => { controller.setTtsPitch(pitch) }}
        onRepair={onRepair}
      />
    </KeyboardAvoidingView>
  )
}

/** Hold-to-talk mic: pulsing while listening, stop glyph while the agent works. */
function MicButton({ theme, listening, busy, onPressIn, onPressOut, onTap, label }: {
  theme: Theme
  listening: boolean
  busy: boolean
  onPressIn(): void
  onPressOut(): void
  onTap(): void
  label: string
}) {
  const pulse = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (!listening) {
      pulse.stopAnimation()
      pulse.setValue(0)
      return
    }
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1100, useNativeDriver: true }))
    loop.start()
    return () => { loop.stop() }
  }, [listening, pulse])
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] })
  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45] })
  const background = listening
    ? theme.danger
    : busy
      ? theme.accentPressed
      : theme.accent
  return (
    <View style={styles.micWrap} accessibilityLabel={label} accessibilityRole="button">
      {listening ? (
        <Animated.View
          style={[styles.micRing, { backgroundColor: theme.danger, opacity: ringOpacity, transform: [{ scale: ringScale }] }]}
        />
      ) : null}
      <Pressable
        style={({ pressed }) => [styles.micButton, { backgroundColor: background }, pressed ? { opacity: 0.85 } : null]}
        onPressIn={onPressIn}
        onPressOut={onPressOut}
        onPress={onTap}
      >
        {busy && !listening
          ? <AppIconStopFill16 size={20} color={theme.textInverse} />
          : <AppIconMic size={22} color={theme.textInverse} />}
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 12, paddingBottom: 8,
  },
  headerTitleWrap: { flex: 1, gap: 2 },
  headerTitle: { fontSize: 16, fontWeight: '600' },
  headerIcon: { padding: 8 },
  statusChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, alignSelf: 'flex-start',
    borderWidth: 1, borderRadius: metrics.radiusPill, paddingHorizontal: 8, paddingVertical: 2,
  },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusChipText: { fontSize: 11 },
  banner: {
    marginHorizontal: 16, marginBottom: 8, borderRadius: metrics.radiusMd, padding: 12,
    flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  bannerText: { flex: 1, fontSize: 13, lineHeight: 18 },
  bannerButton: { borderRadius: metrics.radiusSm, paddingHorizontal: 14, paddingVertical: 8 },
  bannerButtonText: { fontWeight: '600', fontSize: 13 },
  notice: { marginHorizontal: 16, marginBottom: 8, borderRadius: metrics.radiusMd, padding: 10 },
  noticeText: { fontSize: 13 },
  listWrap: { flex: 1 },
  list: { flex: 1, paddingHorizontal: 16 },
  backToBottom: {
    position: 'absolute', right: 16, bottom: 12, width: 38, height: 38, borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center',
  },
  interim: { marginHorizontal: 16, marginBottom: 4, fontStyle: 'italic', textAlign: 'right', fontSize: 13 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 4 },
  statusHint: { fontSize: 12, textAlign: 'center', paddingVertical: 2 },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  imageRail: { flexGrow: 0, marginBottom: 6 },
  imageRailContent: { gap: 8 },
  imageRailItem: { position: 'relative' },
  imageRailThumb: { width: 52, height: 52, borderRadius: metrics.radiusSm },
  imageRailRemove: {
    position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 9,
    backgroundColor: '#b91c1c', alignItems: 'center', justifyContent: 'center',
  },
  imageRailRemoveText: { color: '#fff', fontSize: 12, lineHeight: 16, fontWeight: '700' },
  attachButton: {
    width: 42, height: 42, borderRadius: 21, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  input: {
    flex: 1, borderWidth: 1, borderRadius: metrics.radiusLg,
    paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, maxHeight: 110,
  },
  sendButton: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: 'center', justifyContent: 'center',
  },
  micWrap: { width: 42, height: 42 },
  micRing: { position: 'absolute', width: 42, height: 42, borderRadius: 21 },
  micButton: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: 'center', justifyContent: 'center',
  },
})
