import { useRef, useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { fetch as expoFetch } from 'expo/fetch'
import {
  PairingError, pairWithHost, type FetchLike, type PairingRecord, type PairingFailure,
} from '@deepseek-ai/dsh-client-mobile'

const FAILURE_MESSAGES: Record<PairingFailure, string> = {
  'invalid-url': '无效的配对链接，请扫描终端打印的二维码',
  rejected: '主机拒绝了配对，链接可能已过期',
  'no-cookie': '主机没有返回会话凭证',
  network: '网络连接失败，请检查网络后重试',
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
      setError(failure instanceof PairingError ? FAILURE_MESSAGES[failure.failure] : '配对失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={styles.root}>
      <Text style={styles.title}>连接 DSH 主机</Text>
      <Text style={styles.hint}>
        在电脑终端运行 dsh web --remote，扫描打印出的二维码。
      </Text>
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
              {permission?.canAskAgain === false
                ? '相机权限已被拒绝，请在系统设置中开启'
                : '需要相机权限扫描配对二维码'}
            </Text>
            {permission?.canAskAgain !== false ? (
              <Pressable style={styles.button} onPress={() => void requestPermission()}>
                <Text style={styles.buttonText}>授权相机</Text>
              </Pressable>
            ) : null}
          </View>
        )}
      </View>
      <Text style={styles.or}>或手动粘贴配对链接</Text>
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
          {busy ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>配对</Text>}
        </Pressable>
      </View>
      {error !== null ? (
        <View style={styles.errorRow}>
          <Text style={styles.errorText}>{error}</Text>
          <Pressable style={styles.button} onPress={rescan}>
            <Text style={styles.buttonText}>重新扫描</Text>
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
