import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Modal, Platform, Pressable,
  ScrollView, StatusBar, StyleSheet, Switch, Text, TextInput, View, useColorScheme,
} from 'react-native'
import * as Haptics from 'expo-haptics'
import type {
  ChatMessage, ConnectionStatus, PairingRecord, PendingApproval, PendingQuestion,
  ToolStatusLine,
} from '@deepseek-ai/dsh-client-mobile'
import { useVoiceController } from '../use-voice-controller'
import { useTheme, type Theme } from '../theme'
import { MarkdownBody } from '../components/Markdown'
import { ToolRow } from '../components/ToolRow'

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connecting: '连接中',
  online: '在线',
  reconnecting: '重连中',
  needsPairing: '需要重新配对',
  failed: '连接中断',
}

const LANGUAGES = [
  { value: 'zh-CN', label: '中文（简体）' },
  { value: 'en-US', label: 'English (US)' },
]

/** One row of the conversation flow: a chat message or an inline tool row. */
type TimelineItem =
  | { readonly kind: 'message'; readonly key: string; readonly message: ChatMessage }
  | { readonly kind: 'tool'; readonly key: string; readonly line: ToolStatusLine }

/** The paired host chat screen: voice conversation with a text fallback. */
export function ChatScreen({ record, onRepair }: { record: PairingRecord; onRepair(): void }) {
  const { controller, snapshot } = useVoiceController(record)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const listRef = useRef<FlatList<TimelineItem>>(null)
  const theme = useTheme()
  const scheme = useColorScheme()

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
        <Text style={[styles.muted, { color: theme.textMuted }]}>正在连接…</Text>
      </View>
    )
  }

  const micPress = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)
    if (snapshot.listener === 'idle' && !snapshot.turnRunning) {
      controller.startListening()
    } else if (snapshot.listener === 'listening') {
      controller.stopListening()
    } else {
      controller.stopSpeaking()
      if (snapshot.turnRunning) void controller.cancelTurn()
    }
  }

  const placeholder = draft === ''
    ? snapshot.listener === 'listening'
      ? '正在聆听…（再点一次结束）'
      : snapshot.listener === 'processing'
        ? '处理中…（点击麦克风打断）'
        : snapshot.turnRunning
          ? 'Agent 工作中…'
          : '点击麦克风说话，或输入文字…'
    : undefined

  const micBackground = snapshot.listener === 'listening'
    ? theme.danger
    : snapshot.listener === 'processing' || snapshot.turnRunning
      ? theme.accentPressed
      : theme.accent

  return (
    <KeyboardAvoidingView
      style={[styles.root, { backgroundColor: theme.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} />

      <View style={[styles.header, { backgroundColor: theme.background }]}>
        <Text style={[styles.headerTitle, { color: theme.text }]}>DSH 语音</Text>
        <View style={styles.headerRight}>
          <Text style={[
            styles.statusChip,
            { color: theme.textMuted, borderColor: theme.border },
            snapshot.connection === 'online' ? { color: theme.online, borderColor: theme.online } : null,
          ]}>
            {CONNECTION_LABELS[snapshot.connection]}
          </Text>
          <Pressable onPress={() => setSettingsOpen(true)} hitSlop={8}>
            <Text style={[styles.settingsGear, { color: theme.textMuted }]}>⚙</Text>
          </Pressable>
        </View>
      </View>

      {snapshot.connection === 'needsPairing' || snapshot.connection === 'failed' ? (
        <View style={[styles.banner, { backgroundColor: theme.bannerBg }]}>
          <Text style={[styles.bannerText, { color: theme.bannerText }]}>
            {snapshot.connection === 'needsPairing'
              ? '会话凭证已失效，请重新扫码配对'
              : '与主机的连接中断'}
          </Text>
          <Pressable
            style={[styles.bannerButton, { backgroundColor: theme.danger }]}
            onPress={() => {
              if (snapshot.connection === 'needsPairing') onRepair()
              else controller.reconnect()
            }}
          >
            <Text style={styles.bannerButtonText}>
              {snapshot.connection === 'needsPairing' ? '重新配对' : '重试连接'}
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
          ? <MessageBubble message={item.message} theme={theme} />
          : <ToolRow line={item.line} theme={theme} />}
        ListEmptyComponent={<Text style={[styles.empty, { color: theme.textMuted }]}>说点什么开始对话</Text>}
        onContentSizeChange={() => void listRef.current?.scrollToEnd({ animated: true })}
      />

      {snapshot.pendingApproval !== null ? (
        <ApprovalCard
          approval={snapshot.pendingApproval}
          // The card renders only while pendingApproval is non-null.
          // oxlint-disable-next-line typescript/no-non-null-assertion
          onAnswer={outcome => controller.answerApproval(snapshot.pendingApproval!.approvalId, outcome)}
          theme={theme}
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

      {snapshot.interim !== '' ? (
        <Text style={[styles.interim, { color: theme.textMuted }]}>{snapshot.interim}</Text>
      ) : null}

      <View style={[styles.composer, { borderTopColor: theme.separator, backgroundColor: theme.background }]}>
        <TextInput
          style={[styles.input, { backgroundColor: theme.inputBg, borderColor: theme.border, color: theme.text }]}
          value={draft}
          onChangeText={setDraft}
          placeholder={placeholder}
          placeholderTextColor={theme.textMuted}
          multiline
        />
        {draft.trim() !== '' ? (
          <Pressable
            style={[styles.sendButton, { backgroundColor: theme.accent }]}
            onPress={() => {
              controller.submitText(draft)
              setDraft('')
            }}
          >
            <Text style={styles.sendButtonText}>发送</Text>
          </Pressable>
        ) : null}
        <Pressable style={[styles.micButton, { backgroundColor: micBackground }]} onPress={micPress}>
          <Text style={styles.micIcon}>{snapshot.listener === 'listening' ? '■' : '🎤'}</Text>
        </Pressable>
      </View>

      <SettingsModal
        visible={settingsOpen}
        snapshot={snapshot}
        theme={theme}
        onClose={() => setSettingsOpen(false)}
        onLanguage={language => controller.setLanguage(language)}
        onAutoSpeak={enabled => controller.setAutoSpeak(enabled)}
        onRepair={onRepair}
      />
    </KeyboardAvoidingView>
  )
}

function MessageBubble({ message, theme }: { message: ChatMessage; theme: Theme }) {
  const mine = message.kind === 'user'
  return (
    <View style={[styles.bubbleWrap, mine ? styles.bubbleWrapMine : styles.bubbleWrapTheirs]}>
      {!mine ? <Text style={[styles.roleLabel, { color: theme.textMuted }]}>DSH</Text> : null}
      <View style={[styles.bubble, { backgroundColor: mine ? theme.userBubble : theme.assistantBubble }]}>
        <MarkdownBody text={message.text} theme={theme} inverse={mine} />
        {message.kind === 'assistant' && !message.complete ? (
          <Text style={[styles.typing, { color: theme.textMuted }]}>…</Text>
        ) : null}
      </View>
    </View>
  )
}

function ApprovalCard({
  approval, onAnswer, theme,
}: {
  approval: PendingApproval
  onAnswer(outcome: 'allowed-once' | 'rejected'): void
  theme: Theme
}) {
  return (
    <View style={[styles.card, { backgroundColor: theme.toolBg, borderColor: theme.toolBorder }]}>
      <Text style={[styles.cardTitle, { color: theme.text }]}>Agent 请求批准工具「{approval.toolName}」</Text>
      <View style={styles.cardRow}>
        <Pressable style={[styles.cardButton, { backgroundColor: theme.accent }]} onPress={() => onAnswer('allowed-once')}>
          <Text style={styles.cardButtonText}>允许一次</Text>
        </Pressable>
        <Pressable style={[styles.cardButton, { backgroundColor: theme.danger }]} onPress={() => onAnswer('rejected')}>
          <Text style={styles.cardButtonText}>拒绝</Text>
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

interface SettingsModalProps {
  visible: boolean
  snapshot: { autoSpeak: boolean; language: string }
  theme: Theme
  onClose(): void
  onLanguage(language: string): void
  onAutoSpeak(enabled: boolean): void
  onRepair(): void
}

function SettingsModal({ visible, snapshot, theme, onClose, onLanguage, onAutoSpeak, onRepair }: SettingsModalProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={[styles.modalCard, { backgroundColor: theme.surface }]}>
          <Text style={[styles.modalTitle, { color: theme.text }]}>设置</Text>
          <Text style={[styles.settingLabel, { color: theme.text }]}>识别与朗读语言</Text>
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
            <Text style={[styles.settingLabel, { color: theme.text }]}>自动朗读回复</Text>
            <Switch value={snapshot.autoSpeak} onValueChange={onAutoSpeak} />
          </View>
          <Pressable style={[styles.cardButton, { backgroundColor: theme.danger }]} onPress={onRepair}>
            <Text style={styles.cardButtonText}>断开并重新配对</Text>
          </Pressable>
          <Pressable style={styles.modalClose} onPress={onClose}>
            <Text style={[styles.muted, { color: theme.textMuted }]}>关闭</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
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
  headerTitle: { fontSize: 18, fontWeight: '600' },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  statusChip: {
    fontSize: 12, borderWidth: 1, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, overflow: 'hidden',
  },
  settingsGear: { fontSize: 20 },
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
  card: {
    marginHorizontal: 16, marginBottom: 8, borderRadius: 12, padding: 12, gap: 8,
    borderWidth: 1,
  },
  cardTitle: { fontWeight: '600' },
  cardRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  questionBlock: { gap: 6 },
  cardButton: { borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  cardButtonText: { color: '#fff', fontWeight: '600' },
  interim: { marginHorizontal: 16, fontStyle: 'italic', textAlign: 'right' },
  composer: {
    flexDirection: 'row', alignItems: 'flex-end', gap: 8,
    paddingHorizontal: 12, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth,
  },
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
    borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, gap: 14,
  },
  modalTitle: { fontSize: 18, fontWeight: '600' },
  settingLabel: { fontSize: 15, fontWeight: '500' },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  langButton: { borderRadius: 8, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 8 },
  langButtonText: { fontWeight: '600' },
  modalClose: { alignItems: 'center', paddingVertical: 6 },
})
