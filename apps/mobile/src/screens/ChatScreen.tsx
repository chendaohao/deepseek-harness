import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator, FlatList, Modal, Pressable, ScrollView, StyleSheet, Switch,
  Text, TextInput, View,
} from 'react-native'
import type {
  ChatMessage, ConnectionStatus, PairingRecord, PendingApproval, PendingQuestion,
} from '@deepseek-ai/dsh-client-mobile'
import { useVoiceController } from '../use-voice-controller'

const CONNECTION_LABELS: Record<ConnectionStatus, string> = {
  connecting: '连接中',
  online: '在线',
  reconnecting: '重连中',
  needsPairing: '需要重新配对',
  failed: '连接中断',
}

const LISTENER_HINTS: Record<string, string> = {
  idle: '点击麦克风说话',
  listening: '正在聆听…（再点一次结束）',
  processing: '处理中…（点击打断）',
}

const LANGUAGES = [
  { value: 'zh-CN', label: '中文（简体）' },
  { value: 'en-US', label: 'English (US)' },
]

/** The paired host chat screen: voice conversation with a text fallback. */
export function ChatScreen({ record, onRepair }: { record: PairingRecord; onRepair(): void }) {
  const { controller, snapshot } = useVoiceController(record)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const listRef = useRef<FlatList<ChatMessage>>(null)

  useEffect(() => {
    if (snapshot !== null) {
      void listRef.current?.scrollToEnd({ animated: true })
    }
  }, [snapshot?.messages.length, snapshot?.turnRunning])

  if (snapshot === null || controller === null) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.muted}>正在连接…</Text>
      </View>
    )
  }

  const micPress = (): void => {
    if (snapshot.listener === 'idle' && !snapshot.turnRunning) {
      controller.startListening()
    } else if (snapshot.listener === 'listening') {
      controller.stopListening()
    } else {
      controller.stopSpeaking()
      if (snapshot.turnRunning) void controller.cancelTurn()
    }
  }

  return (
    <View style={styles.root}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>DSH 语音</Text>
        <View style={styles.headerRight}>
          <Text style={[styles.statusChip, snapshot.connection === 'online' ? styles.statusOnline : null]}>
            {CONNECTION_LABELS[snapshot.connection]}
          </Text>
          <Pressable onPress={() => setSettingsOpen(true)} hitSlop={8}>
            <Text style={styles.settingsGear}>⚙</Text>
          </Pressable>
        </View>
      </View>

      {snapshot.connection === 'needsPairing' || snapshot.connection === 'failed' ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            {snapshot.connection === 'needsPairing'
              ? '会话凭证已失效，请重新扫码配对'
              : '与主机的连接中断'}
          </Text>
          <Pressable
            style={styles.bannerButton}
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
        <Pressable style={styles.notice} onPress={() => controller.acknowledgeNotice()}>
          <Text style={styles.noticeText} numberOfLines={2}>{snapshot.notice}</Text>
        </Pressable>
      ) : null}

      <FlatList
        ref={listRef}
        style={styles.list}
        data={snapshot.messages}
        keyExtractor={(item, index) => `${index}-${item.kind}-${item.text.length}`}
        renderItem={({ item }) => <MessageBubble message={item} />}
        ListEmptyComponent={<Text style={styles.empty}>说点什么开始对话</Text>}
        onContentSizeChange={() => void listRef.current?.scrollToEnd({ animated: true })}
      />

      {snapshot.toolLines.length > 0 ? (
        <ScrollView horizontal style={styles.toolStrip} contentContainerStyle={styles.toolStripContent}>
          {snapshot.toolLines.map(line => (
            <View key={line.id} style={styles.toolChip}>
              <Text style={styles.toolChipText}>
                {line.done ? '✓ ' : '… '}{line.name}
              </Text>
            </View>
          ))}
        </ScrollView>
      ) : null}

      {snapshot.pendingApproval !== null ? (
        <ApprovalCard
          approval={snapshot.pendingApproval}
          // The card renders only while pendingApproval is non-null.
          // oxlint-disable-next-line typescript/no-non-null-assertion
          onAnswer={outcome => controller.answerApproval(snapshot.pendingApproval!.approvalId, outcome)}
        />
      ) : null}

      {snapshot.pendingQuestion !== null ? (
        <QuestionCard
          question={snapshot.pendingQuestion}
          // The card renders only while pendingQuestion is non-null.
          // oxlint-disable-next-line typescript/no-non-null-assertion
          onAnswer={answers => controller.answerQuestion(snapshot.pendingQuestion!.questionRpcId, answers)}
        />
      ) : null}

      {snapshot.interim !== '' ? (
        <Text style={styles.interim}>{snapshot.interim}</Text>
      ) : null}

      <View style={styles.composer}>
        <TextInput
          style={styles.input}
          value={draft}
          onChangeText={setDraft}
          placeholder="也可以直接输入文字…"
          multiline
        />
        <Pressable
          style={styles.sendButton}
          onPress={() => {
            controller.submitText(draft)
            setDraft('')
          }}
          disabled={draft.trim() === ''}
        >
          <Text style={styles.sendButtonText}>发送</Text>
        </Pressable>
      </View>

      <View style={styles.micArea}>
        <Pressable
          style={[
            styles.mic,
            snapshot.listener === 'listening' ? styles.micActive : null,
            snapshot.turnRunning ? styles.micRunning : null,
          ]}
          onPress={micPress}
        >
          <Text style={styles.micIcon}>{snapshot.listener === 'listening' ? '■' : '🎤'}</Text>
        </Pressable>
        <Text style={styles.micHint}>
          {/* idle is a literal key of the hint table; the index access above is what can miss. */}
          {/* oxlint-disable-next-line typescript/no-non-null-assertion -- idle is a literal key of the hint table */}
          {LISTENER_HINTS[snapshot.listener] ?? LISTENER_HINTS.idle!}
        </Text>
      </View>

      <SettingsModal
        visible={settingsOpen}
        snapshot={snapshot}
        onClose={() => setSettingsOpen(false)}
        onLanguage={language => controller.setLanguage(language)}
        onAutoSpeak={enabled => controller.setAutoSpeak(enabled)}
        onRepair={onRepair}
      />
    </View>
  )
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const mine = message.kind === 'user'
  return (
    <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
      <Text style={mine ? styles.bubbleTextMine : styles.bubbleText}>{message.text}</Text>
      {message.kind === 'assistant' && !message.complete ? (
        <Text style={styles.typing}>…</Text>
      ) : null}
    </View>
  )
}

function ApprovalCard({ approval, onAnswer }: { approval: PendingApproval; onAnswer(outcome: 'allowed-once' | 'rejected'): void }) {
  return (
    <View style={styles.card}>
      <Text style={styles.cardTitle}>Agent 请求批准工具「{approval.toolName}」</Text>
      <View style={styles.cardRow}>
        <Pressable style={styles.cardButton} onPress={() => onAnswer('allowed-once')}>
          <Text style={styles.cardButtonText}>允许一次</Text>
        </Pressable>
        <Pressable style={[styles.cardButton, styles.cardButtonReject]} onPress={() => onAnswer('rejected')}>
          <Text style={styles.cardButtonText}>拒绝</Text>
        </Pressable>
      </View>
    </View>
  )
}

function QuestionCard({
  question,
  onAnswer,
}: {
  question: PendingQuestion
  onAnswer(answers: { id: string; selected: string[] }[]): void
}) {
  return (
    <View style={styles.card}>
      {question.questions.map(item => (
        <View key={item.id} style={styles.questionBlock}>
          <Text style={styles.cardTitle}>{item.question}</Text>
          <ScrollView horizontal contentContainerStyle={styles.cardRow}>
            {item.options.map(option => (
              <Pressable
                key={option.label}
                style={styles.cardButton}
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
  onClose(): void
  onLanguage(language: string): void
  onAutoSpeak(enabled: boolean): void
  onRepair(): void
}

function SettingsModal({ visible, snapshot, onClose, onLanguage, onAutoSpeak, onRepair }: SettingsModalProps) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard}>
          <Text style={styles.modalTitle}>设置</Text>
          <Text style={styles.settingLabel}>识别与朗读语言</Text>
          <View style={styles.cardRow}>
            {LANGUAGES.map(language => (
              <Pressable
                key={language.value}
                style={[styles.cardButton, snapshot.language === language.value ? styles.cardButtonActive : null]}
                onPress={() => onLanguage(language.value)}
              >
                <Text style={styles.cardButtonText}>{language.label}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.settingRow}>
            <Text style={styles.settingLabel}>自动朗读回复</Text>
            <Switch value={snapshot.autoSpeak} onValueChange={onAutoSpeak} />
          </View>
          <Pressable style={[styles.cardButton, styles.cardButtonReject]} onPress={onRepair}>
            <Text style={styles.cardButtonText}>断开并重新配对</Text>
          </Pressable>
          <Pressable style={styles.modalClose} onPress={onClose}>
            <Text style={styles.muted}>关闭</Text>
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
    fontSize: 12, color: '#666', borderWidth: 1, borderColor: '#ccc',
    borderRadius: 999, paddingHorizontal: 10, paddingVertical: 3, overflow: 'hidden',
  },
  statusOnline: { color: '#15803d', borderColor: '#15803d' },
  settingsGear: { fontSize: 20 },
  banner: {
    marginHorizontal: 16, marginBottom: 8, borderRadius: 10, padding: 12,
    backgroundColor: '#fef2f2', flexDirection: 'row', alignItems: 'center', gap: 12,
  },
  bannerText: { flex: 1, color: '#b91c1c' },
  bannerButton: { backgroundColor: '#b91c1c', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8 },
  bannerButtonText: { color: '#fff', fontWeight: '600' },
  notice: {
    marginHorizontal: 16, marginBottom: 8, borderRadius: 10, padding: 10,
    backgroundColor: '#fffbeb',
  },
  noticeText: { color: '#92400e' },
  list: { flex: 1, paddingHorizontal: 16 },
  empty: { color: '#999', textAlign: 'center', marginTop: 40 },
  bubble: { maxWidth: '85%', borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10, marginVertical: 4 },
  bubbleMine: { alignSelf: 'flex-end', backgroundColor: '#2563eb' },
  bubbleTheirs: { alignSelf: 'flex-start', backgroundColor: '#eee' },
  bubbleText: { color: '#111', fontSize: 15, lineHeight: 21 },
  bubbleTextMine: { color: '#fff', fontSize: 15, lineHeight: 21 },
  typing: { color: '#999' },
  toolStrip: { marginHorizontal: 16 },
  toolStripContent: { gap: 8, paddingVertical: 6 },
  toolChip: {
    backgroundColor: '#eef2ff', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4,
  },
  toolChipText: { color: '#3730a3', fontSize: 12 },
  card: {
    marginHorizontal: 16, marginBottom: 8, borderRadius: 12, padding: 12, gap: 8,
    backgroundColor: '#f8fafc', borderWidth: 1, borderColor: '#e2e8f0',
  },
  cardTitle: { fontWeight: '600', color: '#111' },
  cardRow: { flexDirection: 'row', gap: 8, flexWrap: 'wrap' },
  questionBlock: { gap: 6 },
  cardButton: {
    backgroundColor: '#2563eb', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 8,
  },
  cardButtonActive: { backgroundColor: '#1d4ed8' },
  cardButtonReject: { backgroundColor: '#b91c1c' },
  cardButtonText: { color: '#fff', fontWeight: '600' },
  interim: { marginHorizontal: 16, color: '#666', fontStyle: 'italic' },
  composer: { flexDirection: 'row', alignItems: 'flex-end', gap: 10, paddingHorizontal: 16, paddingVertical: 8 },
  input: {
    flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15, maxHeight: 110,
  },
  sendButton: {
    backgroundColor: '#2563eb', borderRadius: 10, paddingHorizontal: 16, paddingVertical: 12,
  },
  sendButtonText: { color: '#fff', fontWeight: '600' },
  micArea: { alignItems: 'center', paddingBottom: 28, gap: 6 },
  mic: {
    width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#2563eb',
  },
  micActive: { backgroundColor: '#b91c1c' },
  micRunning: { backgroundColor: '#1d4ed8' },
  micIcon: { fontSize: 30 },
  micHint: { color: '#666' },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  modalCard: {
    backgroundColor: '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    padding: 20, gap: 14,
  },
  modalTitle: { fontSize: 18, fontWeight: '600' },
  settingLabel: { fontSize: 15, fontWeight: '500', color: '#111' },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  modalClose: { alignItems: 'center', paddingVertical: 6 },
})
