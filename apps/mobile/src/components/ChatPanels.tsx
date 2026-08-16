import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import type {
  PendingApproval, PendingQuestion, PendingQuestionItem, TodoItemView,
} from '@deepseek-ai/dsh-client-mobile'
import { metrics, type Theme } from '../theme'
import type { Translate } from '../i18n'
import { AppIconCheckOutline16, AppIconListPenOutline16, AppIconThinkOutline16, AppIconWarningOutline16 } from './Icon'

/**
 * The pending-approval card (web ApprovalPanel pattern): a warning strip, the
 * model's justification as the headline, the gated command in monospace, and
 * a one-shot allow/reject row. The controller clears the card optimistically
 * on answer and restores it on transport failure.
 */
export function ApprovalCard({ approval, command, onAnswer, theme, t }: {
  approval: PendingApproval
  command: string | undefined
  onAnswer(outcome: 'allowed-once' | 'rejected'): void
  theme: Theme
  t: Translate
}) {
  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <View style={[styles.strip, { backgroundColor: theme.warningBg }]}>
        <AppIconWarningOutline16 size={14} color={theme.warning} />
        <Text style={[styles.stripText, { color: theme.warningText }]}>{t('waitingApproval')}</Text>
      </View>
      <ScrollView style={styles.body} nestedScrollEnabled>
        <Text style={[styles.headline, { color: theme.text }]}>
          {approval.reason ?? t('approvalEscalation', { tool: approval.toolName })}
        </Text>
        {command !== undefined && command !== '' ? (
          <Text style={[styles.command, { backgroundColor: theme.codeBg, color: theme.codeText }]} selectable>
            {command}
          </Text>
        ) : null}
      </ScrollView>
      <View style={styles.actionRow}>
        <Pressable
          style={({ pressed }) => [
            styles.buttonOutline,
            { borderColor: theme.danger },
            pressed ? { backgroundColor: theme.dangerSoft } : null,
          ]}
          onPress={() => onAnswer('rejected')}
          accessibilityRole="button"
          accessibilityLabel={t('reject')}
        >
          <Text style={[styles.buttonOutlineText, { color: theme.danger }]}>{t('reject')}</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.buttonPrimary,
            { backgroundColor: pressed ? theme.accentPressed : theme.accent },
          ]}
          onPress={() => onAnswer('allowed-once')}
          accessibilityRole="button"
          accessibilityLabel={t('allowOnce')}
        >
          <Text style={[styles.buttonPrimaryText, { color: theme.textInverse }]}>{t('allowOnce')}</Text>
        </Pressable>
      </View>
    </View>
  )
}

/**
 * The pending-questions card. Single-select items answer on tap; multi-select
 * items toggle selections and submit together.
 */
export function QuestionCard({ question, onAnswer, theme, t }: {
  question: PendingQuestion
  onAnswer(answers: { id: string; selected: string[] }[]): void
  theme: Theme
  t: Translate
}) {
  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      {question.questions.map(item => (
        <QuestionItem key={item.id} item={item} onAnswer={onAnswer} theme={theme} t={t} />
      ))}
    </View>
  )
}

/** One question of the batch with its options. */
function QuestionItem({ item, onAnswer, theme, t }: {
  item: PendingQuestionItem
  onAnswer(answers: { id: string; selected: string[] }[]): void
  theme: Theme
  t: Translate
}) {
  const [selected, setSelected] = useState<readonly string[]>([])
  const toggle = (label: string): void => {
    setSelected(current => current.includes(label)
      ? current.filter(entry => entry !== label)
      : [...current, label])
  }
  return (
    <View style={styles.questionBlock}>
      {item.header !== undefined ? (
        <Text style={[styles.questionHeader, { color: theme.accent }]}>{item.header}</Text>
      ) : null}
      <Text style={[styles.questionText, { color: theme.text }]}>{item.question}</Text>
      {item.detail !== undefined && item.detail !== '' ? (
        <Text style={[styles.questionDetail, { color: theme.textMuted }]}>{item.detail}</Text>
      ) : null}
      {item.multiSelect ? (
        <Text style={[styles.multiHint, { color: theme.textMuted }]}>{t('multiSelectHint')}</Text>
      ) : null}
      {item.multiSelect ? (
        <View style={styles.options}>
          {item.options.map((option) => {
            const active = selected.includes(option.label)
            return (
              <Pressable
                key={option.label}
                style={({ pressed }) => [
                  styles.option,
                  { borderColor: active ? theme.accent : theme.border, backgroundColor: theme.background },
                  active ? { backgroundColor: theme.accentSoft } : null,
                  pressed ? styles.optionPressed : null,
                ]}
                onPress={() => toggle(option.label)}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: active }}
                accessibilityLabel={option.label}
              >
                {active ? <AppIconCheckOutline16 size={14} color={theme.accent} /> : null}
                <Text style={[styles.optionText, { color: theme.text }]}>{option.label}</Text>
              </Pressable>
            )
          })}
          {selected.length > 0 ? (
            <Pressable
              style={({ pressed }) => [
                styles.buttonPrimary,
                styles.optionSubmit,
                { backgroundColor: pressed ? theme.accentPressed : theme.accent },
              ]}
              onPress={() => onAnswer([{ id: item.id, selected: [...selected] }])}
              accessibilityRole="button"
              accessibilityLabel={t('submitSelection')}
            >
              <Text style={[styles.buttonPrimaryText, { color: theme.textInverse }]}>{t('submitSelection')}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : (
        <View style={styles.options}>
          {item.options.map(option => (
            <Pressable
              key={option.label}
              style={({ pressed }) => [
                styles.option,
                styles.optionSingle,
                { borderColor: theme.border, backgroundColor: theme.background },
                pressed ? { backgroundColor: theme.accentSoft, borderColor: theme.accent } : null,
              ]}
              onPress={() => onAnswer([{ id: item.id, selected: [option.label] }])}
              accessibilityRole="button"
              accessibilityLabel={option.label}
            >
              <Text style={[styles.optionText, styles.optionTextSingle, { color: theme.text }]}>{option.label}</Text>
              {option.description !== undefined && option.description !== '' ? (
                <Text style={[styles.optionDescription, { color: theme.textMuted }]}>{option.description}</Text>
              ) : null}
            </Pressable>
          ))}
        </View>
      )}
    </View>
  )
}

/** Collapsible todo checklist with a done/total counter in the header. */
export function TodoPanel({ todos, theme, t }: { todos: readonly TodoItemView[]; theme: Theme; t: Translate }) {
  const [collapsed, setCollapsed] = useState(false)
  const done = todos.filter(todo => todo.status === 'completed').length
  return (
    <View style={[styles.todoPanel, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      <Pressable style={styles.todoHead} onPress={() => { setCollapsed(value => !value) }} accessibilityRole="button">
        <AppIconListPenOutline16 size={15} color={theme.textMuted} />
        <Text style={[styles.todoTitle, { color: theme.text }]}>{t('todoTitle')}</Text>
        <Text style={[styles.todoProgress, { color: done === todos.length ? theme.online : theme.textMuted }]}>
          {t('todoProgress', { done: String(done), total: String(todos.length) })}
        </Text>
      </Pressable>
      {collapsed ? null : (
        <ScrollView style={styles.todoList} nestedScrollEnabled>
          {todos.map((todo, index) => (
            <View key={index} style={styles.todoRow}>
              {todo.status === 'completed'
                ? <AppIconCheckOutline16 size={13} color={theme.online} />
                : <Text style={[styles.todoPendingIcon, { color: todo.status === 'in_progress' ? theme.accent : theme.textMuted }]}>
                  {todo.status === 'in_progress' ? '●' : '○'}
                </Text>}
              <Text
                style={[
                  styles.todoText,
                  { color: theme.text },
                  todo.status === 'completed' ? { textDecorationLine: 'line-through', color: theme.textMuted } : null,
                ]}
                numberOfLines={2}
              >
                {todo.content}
              </Text>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  )
}

/** Sticky plan-mode notice shown while the session plans without running tools. */
export function PlanBanner({ theme, t }: { theme: Theme; t: Translate }) {
  return (
    <View style={[styles.planBanner, { backgroundColor: theme.accentSoft }]}>
      <AppIconThinkOutline16 size={14} color={theme.accent} />
      <Text style={[styles.planBannerText, { color: theme.text }]}>{t('planActive')}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16, marginBottom: 8, borderRadius: metrics.radiusMd, padding: 12, gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
  },
  strip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    alignSelf: 'flex-start', borderRadius: metrics.radiusPill, paddingHorizontal: 10, paddingVertical: 4,
  },
  stripText: { fontSize: 12, fontWeight: '600' },
  body: {},
  headline: { fontSize: 15, lineHeight: 21 },
  command: {
    marginTop: 6, borderRadius: metrics.radiusSm, padding: 8,
    fontSize: 13, fontFamily: metrics.mono, lineHeight: 18,
  },
  actionRow: { flexDirection: 'row', gap: 8 },
  buttonPrimary: {
    flex: 1, borderRadius: metrics.radiusSm, paddingVertical: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  buttonPrimaryText: { fontWeight: '600' },
  buttonOutline: {
    flex: 1, borderRadius: metrics.radiusSm, paddingVertical: 10, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  buttonOutlineText: { fontWeight: '600' },
  questionBlock: { gap: 6 },
  questionHeader: { fontSize: 11, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  questionText: { fontSize: 15, fontWeight: '600' },
  questionDetail: { fontSize: 13, lineHeight: 18 },
  multiHint: { fontSize: 12 },
  options: { gap: 6 },
  option: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: metrics.radiusSm, borderWidth: 1, paddingHorizontal: 12, paddingVertical: 10,
  },
  optionPressed: { opacity: 0.8 },
  optionSingle: { alignItems: 'flex-start' },
  optionText: { fontSize: 14, flexShrink: 1 },
  optionTextSingle: { fontWeight: '600' },
  optionDescription: { fontSize: 12, flexShrink: 1 },
  optionSubmit: { marginTop: 2 },
  todoPanel: {
    marginHorizontal: 16, marginBottom: 8, borderRadius: metrics.radiusMd, padding: 12, gap: 6,
    borderWidth: StyleSheet.hairlineWidth,
  },
  todoHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  todoTitle: { flex: 1, fontWeight: '600', fontSize: 13 },
  todoProgress: { fontSize: 12, fontFamily: metrics.mono },
  todoList: { maxHeight: 170 },
  todoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  todoPendingIcon: { fontSize: 11, lineHeight: 18, width: 13, textAlign: 'center' },
  todoText: { flex: 1, fontSize: 13, lineHeight: 18 },
  planBanner: {
    marginHorizontal: 16, marginBottom: 8, borderRadius: metrics.radiusMd, padding: 10,
    flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  planBannerText: { flex: 1, fontSize: 13 },
})
