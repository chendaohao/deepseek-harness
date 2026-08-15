import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { ToolStatusLine } from '@deepseek-ai/dsh-client-mobile'
import type { Theme } from '../theme'

const STATUS_LABELS: Record<ToolStatusLine['status'], string> = {
  running: '运行中',
  done: '完成',
  error: '失败',
}

const STATUS_ICONS: Record<ToolStatusLine['status'], string> = {
  running: '…',
  done: '✓',
  error: '✕',
}

/** One tool activity row in the conversation flow; tap to expand details. */
export function ToolRow({ line, theme }: { line: ToolStatusLine; theme: Theme }) {
  const [expanded, setExpanded] = useState(false)
  const expandable = line.status !== 'running'
  return (
    <Pressable
      style={[styles.row, { backgroundColor: theme.toolBg, borderColor: theme.toolBorder }]}
      disabled={!expandable}
      onPress={() => setExpanded(value => !value)}
    >
      <View style={styles.head}>
        <Text style={[styles.icon, { color: line.status === 'error' ? theme.danger : theme.accent }]}>
          {STATUS_ICONS[line.status]}
        </Text>
        <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>{line.name}</Text>
        <Text style={[styles.status, { color: theme.textMuted }]}>{STATUS_LABELS[line.status]}</Text>
      </View>
      {expanded ? (
        <View style={styles.detail}>
          {line.argumentsText !== '' ? (
            <Text style={[styles.detailText, { color: theme.textMuted }]} selectable>
              参数：{line.argumentsText}
            </Text>
          ) : null}
          {line.resultSummary !== null ? (
            <Text style={[styles.detailText, { color: theme.textMuted }]} selectable>
              结果：{line.resultSummary}
            </Text>
          ) : null}
        </View>
      ) : null}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    alignSelf: 'stretch',
    marginVertical: 4,
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  icon: { fontSize: 13, fontWeight: '700', width: 16, textAlign: 'center' },
  name: { flex: 1, fontSize: 14, fontWeight: '600' },
  status: { fontSize: 12 },
  detail: { gap: 4 },
  detailText: { fontSize: 13, lineHeight: 18 },
})
