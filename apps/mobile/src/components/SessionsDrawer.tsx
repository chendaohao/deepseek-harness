import { useEffect, useState } from 'react'
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type { SessionSummary } from '@deepseek-ai/dsh-client-mobile'
import { metrics, type Theme } from '../theme'
import type { Translate } from '../i18n'
import { relativeTime } from '../relative-time'
import { AppIconNewChatOutline16 } from './Icon'

/** The controller surface the drawer reads. */
export interface SessionsDrawerController {
  listSessions(): Promise<SessionSummary[]>
  switchSession(sessionId: string): void
  createSession(): Promise<SessionSummary | null>
}

/** Last path segment of a working directory, for the row's secondary line. */
function baseName(cwd: string | undefined): string {
  if (cwd === undefined || cwd === '') return ''
  const parts = cwd.split('/').filter(part => part !== '')
  return parts[parts.length - 1] ?? cwd
}

/** Full-width bottom drawer listing host sessions with title, age, and state. */
export function SessionsDrawer({ visible, controller, currentSessionId, theme, t, onClose }: {
  visible: boolean
  controller: SessionsDrawerController
  currentSessionId: string
  theme: Theme
  t: Translate
  onClose(): void
}) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loadedAt, setLoadedAt] = useState(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!visible) return
    setBusy(true)
    void controller.listSessions().then((list) => {
      setSessions(list)
      setLoadedAt(Date.now())
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
      <View style={[styles.backdrop, { backgroundColor: theme.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityLabel={t('close')} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: theme.surface }]}>
          <View style={styles.grab} />
          <Text style={[styles.title, { color: theme.text }]}>{t('sessions')}</Text>
          <Pressable
            style={({ pressed }) => [
              styles.newRow,
              { borderColor: theme.accent },
              pressed ? { backgroundColor: theme.accentSoft } : null,
            ]}
            onPress={newSession}
            disabled={busy}
            accessibilityRole="button"
            accessibilityLabel={t('newSession')}
          >
            <AppIconNewChatOutline16 size={18} color={theme.accent} />
            <Text style={[styles.newRowText, { color: theme.accent }]}>{t('newSession')}</Text>
          </Pressable>
          {busy && sessions.length === 0 ? <ActivityIndicator color={theme.accent} style={styles.busy} /> : null}
          {!busy && sessions.length === 0 ? (
            <Text style={[styles.empty, { color: theme.textMuted }]}>{t('noSessions')}</Text>
          ) : null}
          <ScrollView style={styles.list} contentContainerStyle={styles.listContent} nestedScrollEnabled>
            {sessions.map((session) => {
              const active = session.sessionId === currentSessionId
              const secondary = [
                baseName(session.cwd),
                loadedAt === 0 ? '' : relativeTime(session.updatedAt, loadedAt, t),
              ].filter(part => part !== '').join(' · ')
              return (
                <Pressable
                  key={session.sessionId}
                  style={({ pressed }) => [
                    styles.row,
                    { borderColor: active ? theme.accent : theme.border },
                    active ? { backgroundColor: theme.accentSoft } : null,
                    pressed ? { opacity: 0.7 } : null,
                  ]}
                  onPress={() => {
                    controller.switchSession(session.sessionId)
                    onClose()
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={session.title ?? t('newSession')}
                >
                  <View style={styles.rowMain}>
                    <Text style={[styles.rowTitle, { color: theme.text }]} numberOfLines={1}>
                      {session.title ?? t('newSession')}
                    </Text>
                    {secondary !== '' ? (
                      <Text style={[styles.rowSub, { color: theme.textMuted }]} numberOfLines={1}>{secondary}</Text>
                    ) : null}
                  </View>
                  {session.running ? <View style={[styles.runningDot, { backgroundColor: theme.online }]} /> : null}
                </Pressable>
              )
            })}
          </ScrollView>
          <Pressable style={styles.closeRow} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('close')}>
            <Text style={[styles.closeText, { color: theme.textMuted }]}>{t('close')}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: {
    borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 16, paddingBottom: 8,
    maxHeight: '75%', gap: 10,
  },
  grab: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(128,128,128,0.4)' },
  title: { fontSize: 17, fontWeight: '600' },
  newRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: metrics.radiusMd, borderWidth: 1, paddingVertical: 12, paddingHorizontal: 12,
  },
  newRowText: { fontWeight: '600' },
  busy: { paddingVertical: 12 },
  empty: { paddingVertical: 12, textAlign: 'center' },
  list: { flexGrow: 0 },
  listContent: { gap: 8, paddingBottom: 8 },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: metrics.radiusMd, borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12, paddingVertical: 10,
  },
  rowMain: { flex: 1, gap: 2 },
  rowTitle: { fontSize: 15 },
  rowSub: { fontSize: 12 },
  runningDot: { width: 8, height: 8, borderRadius: 4 },
  closeRow: { alignItems: 'center', paddingVertical: 10 },
  closeText: { fontSize: 15 },
})
