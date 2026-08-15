import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator, Alert, FlatList, Image, KeyboardAvoidingView, Modal, Platform,
  Pressable, ScrollView, Share, StatusBar, StyleSheet, Switch, Text, TextInput, View,
  useColorScheme,
} from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import * as ImageManipulator from 'expo-image-manipulator'
import * as ImagePicker from 'expo-image-picker'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {
  ChatMessage, ConnectionStatus, ModelOption, PairingRecord, PendingApproval,
  PendingQuestion, PromptPart, SessionSummary, ToolStatusLine,
} from '@deepseek-ai/dsh-client-mobile'
import { useVoiceController } from '../use-voice-controller'
import { useTheme, type Theme } from '../theme'
import { useI18n, type I18nKey } from '../i18n'
import { MarkdownBody } from '../components/Markdown'
import { ToolRow } from '../components/ToolRow'

const CONNECTION_LABELS: Record<ConnectionStatus, I18nKey> = {
  connecting: 'connecting',
  online: 'online',
  reconnecting: 'reconnecting',
  needsPairing: 'needsPairing',
  failed: 'failed',
}

const LANGUAGES = [
  { value: 'zh-CN', label: '中文（简体）' },
  { value: 'en-US', label: 'English (US)' },
]

/** One picked draft image: local uri for the rail, base64 data for the wire. */
interface DraftImage {
  readonly uri: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  readonly data: string
  readonly name?: string
}

/** Downloaded-image cache keyed by attachment id (a refetch costs a round trip). */
const imageCache = new Map<string, string>()

/** One row of the conversation flow: a chat message or an inline tool row. */
type TimelineItem =
  | { readonly kind: 'message'; readonly key: string; readonly message: ChatMessage }
  | { readonly kind: 'tool'; readonly key: string; readonly line: ToolStatusLine }

/** The paired host chat screen: voice conversation with text and image input. */
export function ChatScreen({ record, onRepair }: { record: PairingRecord; onRepair(): void }) {
  const { controller, snapshot } = useVoiceController(record)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [draftImages, setDraftImages] = useState<DraftImage[]>([])
  const listRef = useRef<FlatList<TimelineItem>>(null)
  const theme = useTheme()
  const scheme = useColorScheme()
  const { t, quickPrompts } = useI18n()

  useEffect(() => {
    if (snapshot !== null) {
      void listRef.current?.scrollToEnd({ animated: true })
    }
  }, [snapshot?.messages.length, snapshot?.turnRunning])

  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [
      ...snapshot === null ? [] : snapshot.messages.map(message => ({
        kind: 'message' as const,
        key: `m-${message.kind}-${message.seq}`,
        message,
      })),
      ...snapshot === null ? [] : snapshot.toolLines.map(line => ({ kind: 'tool' as const, key: `t-${line.id}`, line })),
    ]
    items.sort((a, b) => {
      const seqA = a.kind === 'message' ? a.message.seq : a.line.seq
      const seqB = b.kind === 'message' ? b.message.seq : b.line.seq
      if (seqA !== seqB) return seqA - seqB
      return a.kind === 'message' ? -1 : 1
    })
    return items
  }, [snapshot?.messages, snapshot?.toolLines])

  if (snapshot === null || controller === null) {
    return (
      <View style={[styles.center, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.accent} />
        <Text style={[styles.muted, { color: theme.textMuted }]}>{t('connecting')}</Text>
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
      { text: t('camera'), onPress: () => void pickImage('camera') },
      { text: t('library'), onPress: () => void pickImage('library') },
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
  }

  // Hold-to-talk: press to start listening, release to send; a tap while the
  // agent works barges in (stop speech + cancel the turn).
  const micPressIn = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    if (snapshot.listener === 'idle' && !snapshot.turnRunning) controller.startListening()
  }
  const micPressOut = (): void => {
    if (snapshot.listener === 'listening') controller.stopListening()
  }
  const micTap = (): void => {
    if (snapshot.listener === 'processing' || snapshot.turnRunning) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
      controller.stopSpeaking()
      if (snapshot.turnRunning) void controller.cancelTurn()
    }
  }

  const hintKey: I18nKey = draft === '' && draftImages.length === 0
    ? snapshot.listener === 'listening'
      ? 'micHintListening'
      : snapshot.listener === 'processing'
        ? 'micHintProcessing'
        : snapshot.turnRunning
          ? 'micHintWorking'
          : 'micHintIdle'
    : 'micHintIdle'

  const micBackground = snapshot.listener === 'listening'
    ? theme.danger
    : snapshot.listener === 'processing' || snapshot.turnRunning
      ? theme.accentPressed
      : theme.accent

  const canSend = draft.trim() !== '' || draftImages.length > 0

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} />

      <View style={[styles.header, { backgroundColor: theme.background }]}>
        <View style={styles.headerLeft}>
          <Text style={[styles.headerTitle, { color: theme.text }]}>{t('title')}</Text>
        </View>
        <View style={styles.headerRight}>
          <Text style={[
            styles.statusChip,
            { color: theme.textMuted, borderColor: theme.border },
            snapshot.connection === 'online' ? { color: theme.online, borderColor: theme.online } : null,
          ]}>
            {t(CONNECTION_LABELS[snapshot.connection])}
          </Text>
          <Pressable onPress={() => setSessionsOpen(true)} hitSlop={8}>
            <Text style={[styles.headerIcon, { color: theme.textMuted }]}>☰</Text>
          </Pressable>
          <Pressable onPress={() => setSettingsOpen(true)} hitSlop={8}>
            <Text style={[styles.headerIcon, { color: theme.textMuted }]}>⚙</Text>
          </Pressable>
        </View>
      </View>

      {snapshot.connection === 'needsPairing' || snapshot.connection === 'failed' ? (
        <View style={[styles.banner, { backgroundColor: theme.bannerBg }]}>
          <Text style={[styles.bannerText, { color: theme.bannerText }]}>
            {snapshot.connection === 'needsPairing' ? t('pairingExpired') : t('connectionLost')}
          </Text>
          <Pressable
            style={[styles.bannerButton, { backgroundColor: theme.danger }]}
            onPress={() => {
              if (snapshot.connection === 'needsPairing') onRepair()
              else controller.reconnect()
            }}
          >
            <Text style={styles.bannerButtonText}>
              {snapshot.connection === 'needsPairing' ? t('repair') : t('retry')}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {snapshot.notice !== null ? (
        <Pressable style={[styles.notice, { backgroundColor: theme.noticeBg }]} onPress={() => controller.acknowledgeNotice()}>
          <Text style={[styles.noticeText, { color: theme.noticeText }]} numberOfLines={2}>{snapshot.notice}</Text>
        </Pressable>
      ) : null}

      <FlatList
        ref={listRef}
        style={styles.list}
        data={timeline}
        keyExtractor={item => item.key}
        renderItem={({ item }) => item.kind === 'message'
          ? <MessageBubble message={item.message} theme={theme} t={t} loadImage={id => controller.downloadImage(id)} />
          : <ToolRow line={item.line} theme={theme} />}
        ListEmptyComponent={<Text style={[styles.empty, { color: theme.textMuted }]}>{t('emptyChat')}</Text>}
        onContentSizeChange={() => void listRef.current?.scrollToEnd({ animated: true })}
      />

      {snapshot.pendingApproval !== null ? (
        <ApprovalCard
          approval={snapshot.pendingApproval}
          // The card renders only while pendingApproval is non-null.
          // oxlint-disable-next-line typescript/no-non-null-assertion
          onAnswer={outcome => controller.answerApproval(snapshot.pendingApproval!.approvalId, outcome)}
          theme={theme}
          t={t}
        />
      ) : null}

      {snapshot.pendingQuestion !== null ? (
        <QuestionCard
          question={snapshot.pendingQuestion}
          // The card renders only while pendingQuestion is non-null.
          // oxlint-disable-next-line typescript/no-non-null-assertion
          onAnswer={answers => controller.answerQuestion(snapshot.pendingQuestion!.questionRpcId, answers)}
          theme={theme}
        />
      ) : null}

      {snapshot.planActive ? (
        <View style={[styles.planBanner, { backgroundColor: theme.noticeBg }]}>
          <Text style={[styles.planBannerText, { color: theme.noticeText }]}>{t('planActive')}</Text>
        </View>
      ) : null}

      {snapshot.todos.length > 0 ? (
        <View style={[styles.todoPanel, { backgroundColor: theme.toolBg, borderColor: theme.toolBorder }]}>
          <Text style={[styles.todoTitle, { color: theme.text }]}>{t('todoTitle')}</Text>
          <ScrollView style={styles.todoList}>
            {snapshot.todos.map((todo, index) => (
              <View key={index} style={styles.todoRow}>
                <Text style={[styles.todoIcon, { color: todo.status === 'completed' ? theme.online : theme.textMuted }]}>
                  {todo.status === 'completed' ? '✓' : todo.status === 'in_progress' ? '…' : '○'}
                </Text>
                <Text
                  style={[styles.todoText, { color: theme.text, textDecorationLine: todo.status === 'completed' ? 'line-through' : 'none' }]}
                  numberOfLines={2}
                >
                  {todo.content}
                </Text>
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {snapshot.interim !== '' ? (
        <Text style={[styles.interim, { color: theme.textMuted }]}>{snapshot.interim}</Text>
      ) : null}

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.promptStrip}
        contentContainerStyle={styles.promptStripContent}
      >
        {quickPrompts.map((prompt, index) => (
          <Pressable
            key={index}
            style={[styles.promptChip, { backgroundColor: theme.toolBg, borderColor: theme.toolBorder }]}
            onPress={() => controller.submitText(prompt)}
          >
            <Text style={[styles.promptChipText, { color: theme.text }]}>{prompt}</Text>
          </Pressable>
        ))}
      </ScrollView>

      <View style={[styles.composer, { borderTopColor: theme.separator, backgroundColor: theme.background }]}>
        <View style={styles.composerMain}>
          {draftImages.length > 0 ? (
            <ScrollView horizontal style={styles.imageRail} contentContainerStyle={styles.imageRailContent}>
              {draftImages.map((image, index) => (
                <View key={index} style={styles.imageRailItem}>
                  <Image source={{ uri: image.uri }} style={styles.imageRailThumb} />
                  <Pressable
                    style={styles.imageRailRemove}
                    onPress={() => setDraftImages(previous => previous.filter((_, i) => i !== index))}
                  >
                    <Text style={styles.imageRailRemoveText}>×</Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          ) : null}
          <View style={styles.composerRow}>
            <Pressable style={[styles.attachButton, { borderColor: theme.border }]} onPress={attachPress}>
              <Text style={[styles.attachIcon, { color: theme.textMuted }]}>📎</Text>
            </Pressable>
            <TextInput
              style={[styles.input, { backgroundColor: theme.inputBg, borderColor: theme.border, color: theme.text }]}
              value={draft}
              onChangeText={setDraft}
              placeholder={hintKey === 'micHintIdle' ? t('micHintIdle') : t(hintKey)}
              placeholderTextColor={theme.textMuted}
              multiline
            />
            {canSend ? (
              <Pressable style={[styles.sendButton, { backgroundColor: theme.accent }]} onPress={sendDraft}>
                <Text style={styles.sendButtonText}>{t('send')}</Text>
              </Pressable>
            ) : null}
            <Pressable
              style={[styles.micButton, { backgroundColor: micBackground }]}
              onPressIn={micPressIn}
              onPressOut={micPressOut}
              onPress={micTap}
            >
              <Text style={styles.micIcon}>{snapshot.listener === 'listening' ? '■' : '🎤'}</Text>
            </Pressable>
          </View>
        </View>
      </View>

      <SessionsModal
        visible={sessionsOpen}
        controller={controller}
        currentSessionId={snapshot.sessionId}
        theme={theme}
        t={t}
        onClose={() => setSessionsOpen(false)}
      />

      <SettingsModal
        visible={settingsOpen}
        snapshot={snapshot}
        controller={controller}
        theme={theme}
        t={t}
        onClose={() => setSettingsOpen(false)}
        onLanguage={language => controller.setLanguage(language)}
        onAutoSpeak={enabled => controller.setAutoSpeak(enabled)}
        onAutoListen={enabled => controller.setAutoListen(enabled)}
        onTtsRate={rate => controller.setTtsRate(rate)}
        onTtsPitch={pitch => controller.setTtsPitch(pitch)}
        onRepair={onRepair}
      />
    </KeyboardAvoidingView>
  )
}

function MessageBubble({
  message, theme, t, loadImage,
}: {
  message: ChatMessage
  theme: Theme
  t: (key: I18nKey, vars?: Record<string, string>) => string
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
    <View style={[styles.bubbleWrap, mine ? styles.bubbleWrapMine : styles.bubbleWrapTheirs]}>
      {!mine ? <Text style={[styles.roleLabel, { color: theme.textMuted }]}>{t('agentLabel')}</Text> : null}
      <Pressable
        style={[styles.bubble, { backgroundColor: mine ? theme.userBubble : theme.assistantBubble }]}
        onLongPress={onLongPress}
        delayLongPress={400}
      >
        {message.kind === 'user' && message.images.length > 0 ? (
          <View style={styles.messageImages}>
            {message.images.map((image, index) => (
              <MessageImage key={image.attachmentId + String(index)} attachment={image} theme={theme} loadImage={loadImage} />
            ))}
          </View>
        ) : null}
        {message.text !== '' ? <MarkdownBody text={message.text} theme={theme} inverse={mine} /> : null}
        {message.kind === 'assistant' && !message.complete ? (
          <Text style={[styles.typing, { color: theme.textMuted }]}>…</Text>
        ) : null}
      </Pressable>
    </View>
  )
}

function MessageImage({
  attachment, theme, loadImage,
}: {
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
  return <Image source={{ uri }} style={styles.messageImage} resizeMode="cover" />
}

function ApprovalCard({
  approval, onAnswer, theme, t,
}: {
  approval: PendingApproval
  onAnswer(outcome: 'allowed-once' | 'rejected'): void
  theme: Theme
  t: (key: I18nKey, vars?: Record<string, string>) => string
}) {
  return (
    <View style={[styles.card, { backgroundColor: theme.toolBg, borderColor: theme.toolBorder }]}>
      <Text style={[styles.cardTitle, { color: theme.text }]}>{t('approvalTitle', { tool: approval.toolName })}</Text>
      <View style={styles.cardRow}>
        <Pressable style={[styles.cardButton, { backgroundColor: theme.accent }]} onPress={() => onAnswer('allowed-once')}>
          <Text style={styles.cardButtonText}>{t('allowOnce')}</Text>
        </Pressable>
        <Pressable style={[styles.cardButton, { backgroundColor: theme.danger }]} onPress={() => onAnswer('rejected')}>
          <Text style={styles.cardButtonText}>{t('reject')}</Text>
        </Pressable>
      </View>
    </View>
  )
}

function QuestionCard({
  question, onAnswer, theme,
}: {
  question: PendingQuestion
  onAnswer(answers: { id: string; selected: string[] }[]): void
  theme: Theme
}) {
  return (
    <View style={[styles.card, { backgroundColor: theme.toolBg, borderColor: theme.toolBorder }]}>
      {question.questions.map(item => (
        <View key={item.id} style={styles.questionBlock}>
          <Text style={[styles.cardTitle, { color: theme.text }]}>{item.question}</Text>
          <ScrollView horizontal contentContainerStyle={styles.cardRow}>
            {item.options.map(option => (
              <Pressable
                key={option.label}
                style={[styles.cardButton, { backgroundColor: theme.accent }]}
                onPress={() => onAnswer([{ id: item.id, selected: [option.label] }])}
              >
                <Text style={styles.cardButtonText}>{option.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ))}
    </View>
  )
}

function SessionsModal({
  visible, controller, currentSessionId, theme, t, onClose,
}: {
  visible: boolean
  controller: {
    listSessions(): Promise<SessionSummary[]>
    switchSession(sessionId: string): void
    createSession(): Promise<SessionSummary | null>
  }
  currentSessionId: string
  theme: Theme
  t: (key: I18nKey, vars?: Record<string, string>) => string
  onClose(): void
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!visible) return
    setBusy(true)
    void controller.listSessions().then((list) => {
      setSessions(list)
      setBusy(false)
    })
  }, [visible, controller])
  const newSession = (): void => {
    setBusy(true)
    void controller.createSession().then(() => {
      setBusy(false)
      onClose()
    })
  }
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalCard, { backgroundColor: theme.surface }]}>
          <Text style={[styles.modalTitle, { color: theme.text }]}>{t('sessions')}</Text>
          {busy ? <ActivityIndicator color={theme.accent} /> : null}
          {!busy && sessions.length === 0 ? (
            <Text style={[styles.muted, { color: theme.textMuted }]}>{t('noSessions')}</Text>
          ) : null}
          <ScrollView style={styles.sessionList}>
            {sessions.map((session) => {
              const active = session.sessionId === currentSessionId
              return (
                <Pressable
                  key={session.sessionId}
                  style={[styles.sessionRow, { borderColor: active ? theme.accent : theme.border, backgroundColor: active ? theme.toolBg : 'transparent' }]}
                  onPress={() => {
                    controller.switchSession(session.sessionId)
                    onClose()
                  }}
                >
                  <Text style={[styles.sessionText, { color: theme.text }]} numberOfLines={1}>
                    {session.sessionId.slice(-8)} {session.running ? '●' : ''} {session.blank ? t('newSession') : ''}
                  </Text>
                </Pressable>
              )
            })}
          </ScrollView>
          <Pressable style={[styles.cardButton, { backgroundColor: theme.accent }]} onPress={newSession} disabled={busy}>
            <Text style={styles.cardButtonText}>{t('newSession')}</Text>
          </Pressable>
          <Pressable style={styles.modalClose} onPress={onClose}>
            <Text style={[styles.muted, { color: theme.textMuted }]}>{t('close')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

interface SettingsModalProps {
  visible: boolean
  snapshot: {
    autoSpeak: boolean
    autoListen: boolean
    ttsRate: number
    ttsPitch: number
    language: string
    selectedModel: string | null
  }
  controller: { listModels(): Promise<ModelOption[]>; selectModel(model: ModelOption): Promise<void> }
  theme: Theme
  t: (key: I18nKey, vars?: Record<string, string>) => string
  onClose(): void
  onLanguage(language: string): void
  onAutoSpeak(enabled: boolean): void
  onAutoListen(enabled: boolean): void
  onTtsRate(rate: number): void
  onTtsPitch(pitch: number): void
  onRepair(): void
}

function SettingsModal({
  visible, snapshot, controller, theme, t, onClose, onLanguage, onAutoSpeak,
  onAutoListen, onTtsRate, onTtsPitch, onRepair,
}: SettingsModalProps) {
  const [models, setModels] = useState<ModelOption[]>([])
  useEffect(() => {
    if (!visible) return
    void controller.listModels().then(setModels)
  }, [visible, controller])
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <ScrollView style={[styles.modalCard, { backgroundColor: theme.surface }]} contentContainerStyle={styles.modalCardContent}>
          <Text style={[styles.modalTitle, { color: theme.text }]}>{t('settings')}</Text>
          <Text style={[styles.settingLabel, { color: theme.text }]}>{t('languageLabel')}</Text>
          <View style={styles.cardRow}>
            {LANGUAGES.map(language => (
              <Pressable
                key={language.value}
                style={[
                  styles.langButton,
                  { borderColor: theme.border },
                  snapshot.language === language.value ? { borderColor: theme.accent, backgroundColor: theme.accent } : null,
                ]}
                onPress={() => onLanguage(language.value)}
              >
                <Text style={[styles.langButtonText, { color: snapshot.language === language.value ? '#fff' : theme.text }]}>
                  {language.label}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.settingRow}>
            <Text style={[styles.settingLabel, { color: theme.text }]}>{t('autoSpeakLabel')}</Text>
            <Switch value={snapshot.autoSpeak} onValueChange={onAutoSpeak} />
          </View>
          <View style={styles.settingRow}>
            <Text style={[styles.settingLabel, { color: theme.text }]}>{t('autoListenLabel')}</Text>
            <Switch value={snapshot.autoListen} onValueChange={onAutoListen} />
          </View>
          <Stepper label={t('ttsRateLabel')} value={snapshot.ttsRate} theme={theme} onChange={onTtsRate} />
          <Stepper label={t('ttsPitchLabel')} value={snapshot.ttsPitch} theme={theme} onChange={onTtsPitch} />
          <Text style={[styles.settingLabel, { color: theme.text }]}>{t('modelLabel')}</Text>
          {models.length === 0 ? (
            <Text style={[styles.muted, { color: theme.textMuted }]}>{t('noModels')}</Text>
          ) : (
            <View style={styles.cardRow}>
              {models.map(model => (
                <Pressable
                  key={model.provider + '/' + model.id}
                  style={[
                    styles.langButton,
                    { borderColor: theme.border },
                    snapshot.selectedModel === model.id ? { borderColor: theme.accent, backgroundColor: theme.accent } : null,
                  ]}
                  onPress={() => void controller.selectModel(model)}
                >
                  <Text style={[styles.langButtonText, { color: snapshot.selectedModel === model.id ? '#fff' : theme.text }]}>
                    {model.name}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
          <Pressable style={[styles.cardButton, { backgroundColor: theme.danger }]} onPress={onRepair}>
            <Text style={styles.cardButtonText}>{t('repairAction')}</Text>
          </Pressable>
          <Pressable style={styles.modalClose} onPress={onClose}>
            <Text style={[styles.muted, { color: theme.textMuted }]}>{t('close')}</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  )
}

function Stepper({
  label, value, theme, onChange,
}: {
  label: string
  value: number
  theme: Theme
  onChange(value: number): void
}) {
  return (
    <View style={styles.settingRow}>
      <Text style={[styles.settingLabel, { color: theme.text }]}>{label}</Text>
      <View style={styles.stepperRow}>
        <Pressable
          style={[styles.stepperButton, { borderColor: theme.border }]}
          onPress={() => onChange(Math.round((value - 0.1) * 10) / 10)}
        >
          <Text style={[styles.stepperText, { color: theme.text }]}>−</Text>
        </Pressable>
        <Text style={[styles.stepperValue, { color: theme.text }]}>{value.toFixed(1)}</Text>
        <Pressable
          style={[styles.stepperButton, { borderColor: theme.border }]}
          onPress={() => onChange(Math.round((value + 0.1) * 10) / 10)}
        >
          <Text style={[styles.stepperText, { color: theme.text }]}>+</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  muted: { color: '#666' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 12,
  },
  headerLeft: { flexDirection: 'row', alignItems: 'center' },
  headerTitle: { fontSize: 18, fontWeight: '600' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerIcon: { fontSize: 20 },
  statusChip: {
    fontSize: 12, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, overflow: 'hidden',
  },
  banner: {
    marginHorizontal: 16, marginBottom: 8, borderRadius: 10, padding: 12,
    flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  bannerText: { flex: 1 },
  bannerButton: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  bannerButtonText: { color: '#fff', fontWeight: '600' },
  notice: { marginHorizontal: 16, marginBottom: 8, borderRadius: 10, padding: 10 },
  noticeText: {},
  list: { flex: 1, paddingHorizontal: 16 },
  empty: { textAlign: 'center', marginTop: 40 },
  bubbleWrap: { marginVertical: 4, maxWidth: '85%' },
  bubbleWrapMine: { alignSelf: 'flex-end', alignItems: 'flex-end' },
  bubbleWrapTheirs: { alignSelf: 'flex-start', alignItems: 'flex-start' },
  roleLabel: { fontSize: 11, marginBottom: 2, marginLeft: 4 },
  bubble: { borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10 },
  typing: { marginTop: 2 },
  messageImages: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 6 },
  messageImage: { width: 180, height: 180, borderRadius: 10 },
  imageLoading: { width: 180, height: 180, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  card: {
    marginHorizontal: 16, marginBottom: 8, borderRadius: 12, padding: 12, gap: 8,
    borderWidth: 1,
  },
  cardTitle: { fontWeight: '600' },
  cardRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  questionBlock: { gap: 6 },
  cardButton: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8, alignItems: 'center' },
  cardButtonText: { color: '#fff', fontWeight: '600' },
  planBanner: { marginHorizontal: 16, marginBottom: 8, borderRadius: 10, padding: 10 },
  planBannerText: { fontSize: 13 },
  todoPanel: {
    marginHorizontal: 16, marginBottom: 8, borderRadius: 12, padding: 12, gap: 6,
    borderWidth: 1, maxHeight: 150,
  },
  todoTitle: { fontWeight: '600', fontSize: 13 },
  todoList: {},
  todoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  todoIcon: { fontSize: 13, width: 14, textAlign: 'center', marginTop: 1 },
  todoText: { flex: 1, fontSize: 13, lineHeight: 18 },
  interim: { marginHorizontal: 16, fontStyle: 'italic', textAlign: 'right' },
  promptStrip: { marginHorizontal: 12, flexGrow: 0 },
  promptStripContent: { gap: 8, paddingVertical: 6, paddingHorizontal: 4 },
  promptChip: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 6 },
  promptChipText: { fontSize: 13 },
  composer: {
    borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, paddingTop: 6, paddingBottom: 10,
  },
  composerMain: { gap: 6 },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  imageRail: { flexGrow: 0 },
  imageRailContent: { gap: 8 },
  imageRailItem: { position: 'relative' },
  imageRailThumb: { width: 52, height: 52, borderRadius: 8 },
  imageRailRemove: {
    position: 'absolute', top: -6, right: -6, width: 18, height: 18, borderRadius: 9,
    backgroundColor: '#b91c1c', alignItems: 'center', justifyContent: 'center',
  },
  imageRailRemoveText: { color: '#fff', fontSize: 12, lineHeight: 16, fontWeight: '700' },
  attachButton: {
    width: 40, height: 40, borderRadius: 20, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  attachIcon: { fontSize: 16 },
  input: {
    flex: 1, borderWidth: 1, borderRadius: 20,
    paddingHorizontal: 14, paddingVertical: 10, fontSize: 15, maxHeight: 110,
  },
  sendButton: {
    borderRadius: 20, paddingHorizontal: 16, paddingVertical: 10,
  },
  sendButtonText: { color: '#fff', fontWeight: '600' },
  micButton: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
  },
  micIcon: { fontSize: 18 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalCard: {
    borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20,
    maxHeight: '70%',
  },
  modalCardContent: { gap: 14 },
  modalTitle: { fontSize: 18, fontWeight: '600' },
  settingLabel: { fontSize: 15, fontWeight: '500' },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepperButton: { width: 32, height: 32, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  stepperText: { fontSize: 18 },
  stepperValue: { fontSize: 15, minWidth: 36, textAlign: 'center' },
  langButton: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8 },
  langButtonText: { fontWeight: '600' },
  sessionList: { maxHeight: 260 },
  sessionRow: {
    borderRadius: 10, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 8,
  },
  sessionText: { fontSize: 14 },
  modalClose: { alignItems: 'center', paddingVertical: 6 },
})
