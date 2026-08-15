import { useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { fetch as expoFetch } from 'expo/fetch'
import {
  PairingError, pairWithHost, type FetchLike, type PairingRecord, type PairingFailure,
} from '@deepseek-ai/dsh-client-mobile'
import { useI18n } from '../i18n'

const FAILURE_KEYS: Record<PairingFailure, 'pairInvalidUrl' | 'pairRejected' | 'pairNoCookie' | 'pairNetwork'> = {
  'invalid-url': 'pairInvalidUrl',
  rejected: 'pairRejected',
  'no-cookie': 'pairNoCookie',
  network: 'pairNetwork',
}

/** QR scan + manual URL pairing against the remote-access gate. */
export function PairScreen({ onPaired }: { onPaired(record: PairingRecord): void }) {
  const [permission, requestPermission] = useCameraPermissions()
  const [manualUrl, setManualUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One pairing attempt per scan: the host owns the failure budget, so the
  // scanner stays locked until the user explicitly re-arms it.
  const [scanned, setScanned] = useState(false)
  const scanLocked = useRef(false)
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
      const record = await pairWithHost(raw, expoFetch as FetchLike)
      onPaired(record)
    } catch (failure) {
      setError(failure instanceof PairingError ? t(FAILURE_KEYS[failure.failure]) : t('pairFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>{t('pairTitle')}</Text>
      <Text style={styles.hint}>{t('pairHint')}</Text>
      <View style={styles.cameraBox}>
        {permission?.granted ? (
          <CameraView
            style={styles.camera}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={scanned ? undefined : handleScan}
          />
        ) : (
          <View style={styles.cameraFallback}>
            <Text style={styles.cameraFallbackText}>
              {permission?.canAskAgain === false ? t('pairScanFallbackDenied') : t('pairScanFallback')}
            </Text>
            {permission?.canAskAgain !== false ? (
              <Pressable style={styles.button} onPress={() => void requestPermission()}>
                <Text style={styles.buttonText}>{t('pairGrantCamera')}</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>
      <Text style={styles.or}>{t('pairOr')}</Text>
      <View style={styles.manualRow}>
        <TextInput
          style={styles.input}
          value={manualUrl}
          onChangeText={setManualUrl}
          placeholder="https://…/pair/…"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={!busy}
        />
        <Pressable
          style={[styles.button, busy ? styles.buttonDisabled : null]}
          onPress={() => void tryPair(manualUrl)}
          disabled={busy}
        >
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>{t('pair')}</Text>}
        </Pressable>
      </View>
      {error !== null ? (
        <View style={styles.errorRow}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.button} onPress={rescan}>
            <Text style={styles.buttonText}>{t('pairRescan')}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, padding: 24, paddingTop: 72, gap: 16 },
  title: { fontSize: 24, fontWeight: '600', textAlign: 'center' },
  hint: { color: '#666', textAlign: 'center', lineHeight: 22 },
  cameraBox: { height: 280, borderRadius: 16, overflow: 'hidden', backgroundColor: '#111' },
  camera: { flex: 1 },
  cameraFallback: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 16 },
  cameraFallbackText: { color: '#bbb', textAlign: 'center' },
  or: { color: '#666', textAlign: 'center' },
  manualRow: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  input: {
    flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
  },
  button: {
    backgroundColor: '#2563eb', borderRadius: 10, paddingHorizontal: 20, paddingVertical: 12,
    alignItems: 'center', justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.5 },
  buttonText: { color: '#fff', fontWeight: '600' },
  errorRow: { alignItems: 'center', gap: 10 },
  errorText: { color: '#b91c1c', textAlign: 'center' },
})
