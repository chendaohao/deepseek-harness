import { useEffect, useState } from 'react'
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import type { ModelOption } from '@deepseek-ai/dsh-client-mobile'
import { metrics, type Theme } from '../theme'
import type { Translate } from '../i18n'
import { AppIconCheckOutline16 } from './Icon'

const LANGUAGES = [
  { value: 'zh-CN', label: '中文（简体）' },
  { value: 'en-US', label: 'English (US)' },
]

/** The settings snapshot fields the sheet reads. */
export interface SettingsSnapshot {
  autoSpeak: boolean
  autoListen: boolean
  ttsRate: number
  ttsPitch: number
  language: string
  selectedModel: string | null
}

/** The controller surface the sheet reads. */
export interface SettingsSheetController {
  listModels(): Promise<ModelOption[]>
  selectModel(model: ModelOption): Promise<void>
}

/** Settings bottom sheet: model, language, voice, and the paired host. */
export function SettingsSheet({ visible, snapshot, controller, host, theme, t, onClose, onLanguage, onAutoSpeak,
  onAutoListen, onTtsRate, onTtsPitch, onRepair }: {
  visible: boolean
  snapshot: SettingsSnapshot
  controller: SettingsSheetController
  host: string
  theme: Theme
  t: Translate
  onClose(): void
  onLanguage(language: string): void
  onAutoSpeak(enabled: boolean): void
  onAutoListen(enabled: boolean): void
  onTtsRate(rate: number): void
  onTtsPitch(pitch: number): void
  onRepair(): void
}) {
  const [models, setModels] = useState<ModelOption[]>([])
  useEffect(() => {
    if (!visible) return
    void controller.listModels().then(setModels)
  }, [visible, controller])
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={[styles.backdrop, { backgroundColor: theme.overlay }]}>
        <Pressable style={StyleSheet.absoluteFill} accessibilityLabel={t('close')} onPress={onClose} />
        <ScrollView
          style={[styles.sheet, { backgroundColor: theme.surface }]}
          contentContainerStyle={styles.sheetContent}
          nestedScrollEnabled
        >
          <View style={styles.grab} />
          <Text style={[styles.title, { color: theme.text }]}>{t('settings')}</Text>

          <Text style={[styles.sectionTitle, { color: theme.textMuted }]}>{t('modelLabel')}</Text>
          {models.length === 0 ? (
            <Text style={[styles.muted, { color: theme.textMuted }]}>{t('noModels')}</Text>
          ) : (
            <View style={styles.modelList}>
              {models.map((model) => {
                const active = snapshot.selectedModel === model.id
                return (
                  <Pressable
                    key={model.provider + '/' + model.id}
                    style={({ pressed }) => [
                      styles.modelRow,
                      { borderColor: active ? theme.accent : theme.border },
                      active ? { backgroundColor: theme.accentSoft } : null,
                      pressed ? { opacity: 0.7 } : null,
                    ]}
                    onPress={() => { void controller.selectModel(model) }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: active }}
                    accessibilityLabel={model.name}
                  >
                    <View style={styles.modelText}>
                      <Text style={[styles.modelName, { color: theme.text }]} numberOfLines={1}>{model.name}</Text>
                      <Text style={[styles.modelProvider, { color: theme.textMuted }]} numberOfLines={1}>{model.provider}</Text>
                    </View>
                    {active ? <AppIconCheckOutline16 size={16} color={theme.accent} /> : null}
                  </Pressable>
                )
              })}
            </View>
          )}

          <Text style={[styles.sectionTitle, { color: theme.textMuted }]}>{t('languageLabel')}</Text>
          <View style={styles.languageRow}>
            {LANGUAGES.map((language) => {
              const active = snapshot.language === language.value
              return (
                <Pressable
                  key={language.value}
                  style={({ pressed }) => [
                    styles.languageButton,
                    { borderColor: active ? theme.accent : theme.border },
                    active ? { backgroundColor: theme.accent } : null,
                    pressed ? { opacity: 0.7 } : null,
                  ]}
                  onPress={() => { onLanguage(language.value) }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={language.label}
                >
                  <Text style={[styles.languageText, { color: active ? theme.textInverse : theme.text }]}>
                    {language.label}
                  </Text>
                </Pressable>
              )
            })}
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

          <Text style={[styles.sectionTitle, { color: theme.textMuted }]}>{t('hostLabel')}</Text>
          <Text style={[styles.hostValue, { color: theme.text }]} numberOfLines={1} selectable>{host}</Text>
          <Pressable
            style={({ pressed }) => [
              styles.repairButton,
              { borderColor: theme.danger },
              pressed ? { backgroundColor: theme.dangerSoft } : null,
            ]}
            onPress={onRepair}
            accessibilityRole="button"
            accessibilityLabel={t('repairAction')}
          >
            <Text style={[styles.repairText, { color: theme.danger }]}>{t('repairAction')}</Text>
          </Pressable>
          <Pressable style={styles.closeRow} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('close')}>
            <Text style={[styles.closeText, { color: theme.textMuted }]}>{t('close')}</Text>
          </Pressable>
        </ScrollView>
      </View>
    </Modal>
  )
}

/** One numeric stepper row (TTS rate and pitch). */
function Stepper({ label, value, theme, onChange }: {
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
          style={({ pressed }) => [
            styles.stepperButton,
            { borderColor: theme.border },
            pressed ? { opacity: 0.6 } : null,
          ]}
          onPress={() => { onChange(Math.round((value - 0.1) * 10) / 10) }}
          accessibilityRole="button"
          accessibilityLabel={label + ' -'}
        >
          <Text style={[styles.stepperText, { color: theme.text }]}>−</Text>
        </Pressable>
        <Text style={[styles.stepperValue, { color: theme.text }]}>{value.toFixed(1)}</Text>
        <Pressable
          style={({ pressed }) => [
            styles.stepperButton,
            { borderColor: theme.border },
            pressed ? { opacity: 0.6 } : null,
          ]}
          onPress={() => { onChange(Math.round((value + 0.1) * 10) / 10) }}
          accessibilityRole="button"
          accessibilityLabel={label + ' +'}
        >
          <Text style={[styles.stepperText, { color: theme.text }]}>+</Text>
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '80%' },
  sheetContent: { padding: 16, paddingBottom: 8, gap: 12 },
  grab: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(128,128,128,0.4)', marginBottom: 2 },
  title: { fontSize: 17, fontWeight: '600' },
  sectionTitle: { fontSize: 12, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase', marginTop: 4 },
  muted: { fontSize: 14 },
  modelList: { gap: 6 },
  modelRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    borderRadius: metrics.radiusSm, borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12, paddingVertical: 10,
  },
  modelText: { flex: 1, gap: 1 },
  modelName: { fontSize: 14, fontWeight: '600' },
  modelProvider: { fontSize: 12 },
  languageRow: { flexDirection: 'row', gap: 8 },
  languageButton: {
    borderRadius: metrics.radiusPill, borderWidth: 1, paddingHorizontal: 16, paddingVertical: 8,
  },
  languageText: { fontWeight: '600' },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  settingLabel: { fontSize: 15, flex: 1, flexShrink: 1, paddingRight: 12 },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepperButton: {
    width: 34, height: 34, borderRadius: metrics.radiusSm, borderWidth: 1,
    alignItems: 'center', justifyContent: 'center',
  },
  stepperText: { fontSize: 18 },
  stepperValue: { fontSize: 15, minWidth: 36, textAlign: 'center', fontFamily: metrics.mono },
  hostValue: { fontSize: 14, fontFamily: metrics.mono },
  repairButton: {
    borderRadius: metrics.radiusSm, borderWidth: 1, paddingVertical: 10,
    alignItems: 'center', justifyContent: 'center',
  },
  repairText: { fontWeight: '600' },
  closeRow: { alignItems: 'center', paddingVertical: 10 },
  closeText: { fontSize: 15 },
})
