import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import * as Haptics from 'expo-haptics'
import type { ToolStatusLine } from '@deepseek-ai/dsh-client-mobile'
import { metrics, type Theme } from '../theme'
import type { Translate } from '../i18n'
import { AppIconCheckOutline16, AppIconCloseOutline16, AppIconCopyOutline16 } from './Icon'

/** Argument fields shown as the row's one-line preview, in preference order. */
const PREVIEW_FIELDS = ['command', 'file_path', 'path', 'pattern', 'query'] as const

/** Parsed tool arguments; null when the model's JSON does not parse. */
function parseArguments(line: ToolStatusLine): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line.argumentsText) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/** The row's preview value: the first known field as a string, else the tool name. */
function previewOf(line: ToolStatusLine): { value: string; mono: boolean } {
  const args = parseArguments(line)
  if (args !== null) {
    for (const field of PREVIEW_FIELDS) {
      const value = args[field]
      if (typeof value === 'string' && value !== '') return { value, mono: field === 'command' }
    }
  }
  return { value: line.name, mono: false }
}

/** One key/value line of the expanded argument list, value-capped. */
function argumentLine(key: string, value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const capped = text !== undefined && text.length > 120 ? text.slice(0, 120) + '…' : text
  return key + ': ' + String(capped)
}

/** One tool activity row in the conversation flow; tap to expand details. */
export function ToolRow({ line, theme, t }: { line: ToolStatusLine; theme: Theme; t: Translate }) {
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const expandable = line.status !== 'running'
  const preview = previewOf(line)
  const args = parseArguments(line)
  const statusLabel = line.status === 'running' ? t('toolRunning') : line.status === 'error' ? t('toolError') : t('toolDone')
  const command = args?.command
  const toggle = (): void => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)
    setExpanded(value => !value)
  }
  const copyCommand = (): void => {
    if (typeof command !== 'string') return
    void Clipboard.setStringAsync(command).then(() => {
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1500)
    })
  }
  return (
    <Pressable
      style={({ pressed }) => [
        styles.row,
        { backgroundColor: pressed ? theme.accentSoft : theme.surfaceMuted, borderColor: theme.border },
      ]}
      disabled={!expandable}
      onPress={toggle}
      accessibilityRole="button"
      accessibilityLabel={line.name + ' ' + statusLabel}
    >
      <View style={styles.head}>
        {line.status === 'running'
          ? <ActivityIndicator size="small" color={theme.accent} />
          : line.status === 'error'
            ? <AppIconCloseOutline16 size={15} color={theme.danger} />
            : <AppIconCheckOutline16 size={15} color={theme.online} />}
        <Text
          style={[
            styles.name,
            { color: theme.text },
            preview.mono ? { fontFamily: metrics.mono, fontSize: 13 } : null,
          ]}
          numberOfLines={1}
        >
          {preview.value}
        </Text>
        {!preview.mono ? <Text style={[styles.toolName, { color: theme.textMuted }]} numberOfLines={1}>{line.name}</Text> : null}
        <Text style={[styles.status, { color: line.status === 'error' ? theme.danger : theme.textMuted }]}>{statusLabel}</Text>
      </View>
      {expanded ? (
        <View style={styles.detail}>
          {typeof command === 'string' && command !== '' ? (
            <View style={[styles.commandBlock, { backgroundColor: theme.codeBg, borderColor: theme.border }]}>
              <View style={styles.commandHead}>
                <Text style={[styles.commandLabel, { color: theme.textMuted }]}>{t('commandLabel')}</Text>
                <Pressable onPress={copyCommand} hitSlop={8} accessibilityLabel={t('copy')} accessibilityRole="button">
                  {copied
                    ? <AppIconCheckOutline16 size={15} color={theme.online} />
                    : <AppIconCopyOutline16 size={15} color={theme.textMuted} />}
                </Pressable>
              </View>
              <Text style={[styles.commandText, { color: theme.codeText }]} selectable>{command}</Text>
            </View>
          ) : null}
          {args !== null ? (
            <View style={styles.args}>
              {Object.entries(args).slice(0, 8).map(([key, value]) => (
                <Text key={key} style={[styles.detailText, { color: theme.textMuted }]} selectable>
                  {argumentLine(key, value)}
                </Text>
              ))}
            </View>
          ) : line.argumentsText !== '' ? (
            <Text style={[styles.detailText, { color: theme.textMuted }]} selectable>{t('argsLabel')}: {line.argumentsText}</Text>
          ) : null}
          {line.resultSummary !== null ? (
            <Text style={[styles.detailText, { color: theme.textMuted }]} selectable numberOfLines={6}>
              {t('resultLabel')}: {line.resultSummary}
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
    borderRadius: metrics.radiusMd,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { flexShrink: 1, fontSize: 14, fontWeight: '600' },
  toolName: { flexShrink: 1, fontSize: 12 },
  status: { fontSize: 12 },
  detail: { gap: 4 },
  commandBlock: {
    borderRadius: metrics.radiusSm, borderWidth: StyleSheet.hairlineWidth, padding: 8, gap: 2,
  },
  commandHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  commandLabel: { fontSize: 11 },
  commandText: { fontSize: 13, fontFamily: metrics.mono, lineHeight: 18 },
  args: { gap: 2 },
  detailText: { fontSize: 13, lineHeight: 18 },
})
