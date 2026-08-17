/**
 * Bound-device management screen: shows the current host binding (this
 * device's label and the paired host origin) with the auto-unbind rule, and
 * offers re-pair or unbind. The host web settings page lists every bound
 * device; this screen manages the local side of the binding.
 */

import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import * as Device from 'expo-device'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { PairingRecord } from '@deepseek-ai/dsh-client-mobile'
import { useTheme } from '../theme'
import { useI18n } from '../i18n'

/** The bound-device management screen's contract. */
export interface DeviceBindingScreenProps {
  /** The bound host this device is paired with. */
  record: PairingRecord
  /** Drop the credential and start a fresh pairing. */
  onRepair(): void
  /** Unbind this device (confirmed in the screen). */
  onUnbind(): void
}

/** One labeled row inside the binding card. */
function InfoRow({ label, value, theme }: {
  label: string
  value: string
  theme: ReturnType<typeof useTheme>
}) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, { color: theme.textMuted }]}>{label}</Text>
      <Text style={[styles.rowValue, { color: theme.text }]} numberOfLines={1}>{value}</Text>
    </View>
  )
}

/** The bound-device management screen. */
export function DeviceBindingScreen({ record, onRepair, onUnbind }: DeviceBindingScreenProps) {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { t } = useI18n()
  const deviceName = Device.modelName ?? Device.deviceName ?? t('devicesUnknown')

  const confirmUnbind = (): void => {
    Alert.alert(t('devicesUnbindConfirmTitle'), t('devicesUnbindConfirmBody'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('devicesUnbind'), style: 'destructive', onPress: onUnbind },
    ])
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.background, paddingTop: insets.top + 24 }]}>
      <Text style={[styles.title, { color: theme.text }]}>{t('devicesTitle')}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{t('devicesHint')}</Text>

      <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <InfoRow label={t('devicesDevice')} value={deviceName} theme={theme} />
        <InfoRow label={t('devicesHost')} value={record.baseUrl} theme={theme} />
        <InfoRow label={t('devicesExpiryHint')} value={t('devicesBound')} theme={theme} />
      </View>

      <Pressable
        style={({ pressed }) => [styles.button, { backgroundColor: theme.surface, borderColor: theme.border, opacity: pressed ? 0.7 : 1 }]}
        onPress={onRepair}
        accessibilityRole="button"
      >
        <Text style={[styles.buttonText, { color: theme.text }]}>{t('devicesRepair')}</Text>
      </Pressable>
      <Pressable
        style={({ pressed }) => [styles.button, { backgroundColor: theme.surface, borderColor: theme.border, opacity: pressed ? 0.7 : 1 }]}
        onPress={confirmUnbind}
        accessibilityRole="button"
      >
        <Text style={[styles.buttonText, { color: theme.danger }]}>{t('devicesUnbind')}</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, paddingHorizontal: 20, gap: 12 },
  title: { fontSize: 22, fontWeight: '600' },
  hint: { fontSize: 13, lineHeight: 19 },
  card: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, marginTop: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12, paddingVertical: 12 },
  rowLabel: { fontSize: 13 },
  rowValue: { fontSize: 13, flexShrink: 1 },
  button: { borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 13, alignItems: 'center', marginTop: 8 },
  buttonText: { fontSize: 15, fontWeight: '500' },
})
