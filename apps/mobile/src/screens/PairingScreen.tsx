import { useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, useColorScheme } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { fetch as expoFetch } from 'expo/fetch'
import * as Device from 'expo-device'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  PairingError, pairWithHost, type FetchLike, type PairingRecord, type PairingFailure,
} from '@deepseek-ai/dsh-client-mobile'
import { useTheme } from '../theme'
import { useI18n, type I18nKey } from '../i18n'

const FAILURE_KEYS: Record<PairingFailure, I18nKey> = {
  'invalid-url': 'pairInvalidUrl',
  rejected: 'pairRejected',
  'no-cookie': 'pairNoCookie',
  network: 'pairNetwork',
}

/** QR scan + manual URL pairing against the remote-access gate. */
export function PairingScreen({ onPaired }: { onPaired(record: PairingRecord): void | Promise<void> }) {
  const [permission, requestPermission] = useCameraPermissions()
  const [manualUrl, setManualUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One pairing attempt per scan: the host owns the failure budget, so the
  // scanner stays locked until the user explicitly re-arms it.
  const [scanned, setScanned] = useState(false)
  const scanLocked = useRef(false)
  const theme = useTheme()
  const scheme = useColorScheme()
  const insets = useSafeAreaInsets()
  const { t } = useI18n()

  const handleScan = ({ data }: { data: string }): void => {
    if (scanLocked.current) return
    scanLocked.current = true
    setScanned(true)
    void tryPair(data)
  }

  const rescan = (): void => {
    scanLocked.current = false
    setScanned(false)
    setError(null)
  }

  const tryPair = async (raw: string): Promise<void> => {
    if (busy || raw.trim() === '') return
    setBusy(true)
    setError(null)
    try {
      // The model name labels this binding in the host's device list.
      const deviceName = Device.modelName ?? Device.deviceName
      const record = await pairWithHost(raw, expoFetch as FetchLike,
        deviceName === null ? {} : { deviceName })
      // Persistence (keychain) failures surface here instead of rejecting the
      // handler's promise: the host already paired, so re-pairing is the
      // recovery and the message must say the save failed, not the pairing.
      try {
        await onPaired(record)
      } catch {
        setError(t('pairPersistFailed'))
      }
    } catch (failure) {
      setError(failure instanceof PairingError ? t(FAILURE_KEYS[failure.failure]) : t('pairFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={[styles.root, { backgroundColor: theme.background, paddingTop: insets.top + 24 }]}>
      <Text style={[styles.title, { color: theme.text }]}>{t('pairTitle')}</Text>
      <Text style={[styles.hint, { color: theme.textMuted }]}>{t('pairHint')}</Text>
      <View style={[styles.cameraBox, { backgroundColor: scheme === 'dark' ? '#05070a' : '#111' }]}>
        {permission?.granted ? (
          <CameraView
            style={styles.camera}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={scanned ? undefined : handleScan}
          />
        ) : (
          <View style={styles.cameraFallback}>
            <Text style={[styles.cameraFallbackText, { color: theme.textMuted }]}>
              {permission?.canAskAgain === false ? t('pairScanFallbackDenied') : t('pairScanFallback')}
            </Text>
            {permission?.canAskAgain !== false ? (
              <Pressable
                style={({ pressed }) => [styles.button, { backgroundColor: theme.accent }, pressed ? { opacity: 0.85 } : null]}
                onPress={() => { void requestPermission() }}
                accessibilityRole="button"
                accessibilityLabel={t('pairGrantCamera')}
              >
                <Text style={[styles.buttonText, { color: theme.textInverse }]}>{t('pairGrantCamera')}</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>
      <Text style={[styles.or, { color: theme.textMuted }]}>{t('pairOr')}</Text>
      <View style={styles.manualRow}>
        <TextInput
          style={[styles.input, { borderColor: theme.border, color: theme.text }]}
          value={manualUrl}
          onChangeText={setManualUrl}
          placeholder="https://…/pair/…"
          placeholderTextColor={theme.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={!busy}
        />
        <Pressable
          style={({ pressed }) => [
            styles.button,
            { backgroundColor: theme.accent },
            busy ? styles.buttonDisabled : null,
            pressed ? { opacity: 0.85 } : null,
          ]}
          onPress={() => { void tryPair(manualUrl) }}
          disabled={busy}
          accessibilityRole="button"
          accessibilityLabel={t('pair')}
        >
          {busy ? <ActivityIndicator color={theme.textInverse} /> : (
            <Text style={[styles.buttonText, { color: theme.textInverse }]}>{t('pair')}</Text>
          )}
        </Pressable>
      </View>
      {error !== null ? (
        <View style={styles.errorRow}>
          <Text style={[styles.errorText, { color: theme.danger }]}>{error}</Text>
          <Pressable
            style={({ pressed }) => [styles.button, { backgroundColor: theme.accent }, pressed ? { opacity: 0.85 } : null]}
            onPress={rescan}
            accessibilityRole="button"
            accessibilityLabel={t('pairRescan')}
          >
            <Text style={[styles.buttonText, { color: theme.textInverse }]}>{t('pairRescan')}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24, gap: 16 },
  title: { fontSize: 24, fontWeight: '600', textAlign: 'center' },
  hint: { textAlign: 'center', lineHeight: 22 },
  cameraBox: { height: 280, borderRadius: 16, overflow: 'hidden' },
  camera: { flex: 1 },
  cameraFallback: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 16 },
  cameraFallbackText: { textAlign: 'center' },
  or: { textAlign: 'center' },
  manualRow: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  input: {
    flex: 1, borderWidth: 1, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
  },
  button: {
    borderRadius: 10, paddingHorizontal: 20, paddingVertical: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { fontWeight: '600' },
  errorRow: { alignItems: 'center', gap: 10 },
  errorText: { textAlign: 'center' },
})
