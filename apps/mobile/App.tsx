import { useEffect, useState } from 'react'
import { ActivityIndicator, StatusBar, StyleSheet, Text, View } from 'react-native'
import type { PairingRecord } from '@deepseek-ai/dsh-client-mobile'
import { clearPairing, loadPairing, savePairing } from './src/adapters/pairing-store'
import { ChatScreen } from './src/screens/ChatScreen'
import { PairScreen } from './src/screens/PairScreen'

type Stage = 'loading' | 'pair' | 'chat'

/** App root: load the persisted pairing, then route between pair and chat. */
export default function App() {
  const [stage, setStage] = useState<Stage>('loading')
  const [record, setRecord] = useState<PairingRecord | null>(null)

  useEffect(() => {
    void loadPairing().then((loaded) => {
      if (loaded !== null) {
        setRecord(loaded)
        setStage('chat')
      } else {
        setStage('pair')
      }
    })
  }, [])

  return (
    <View style={styles.root}>
      <StatusBar barStyle="dark-content" />
      {stage === 'loading' ? (
        <View style={styles.center}>
          <ActivityIndicator size="large" />
          <Text style={styles.loading}>正在读取配对信息…</Text>
        </View>
      ) : stage === 'pair' ? (
        <PairScreen
          onPaired={async (next) => {
            await savePairing(next)
            setRecord(next)
            setStage('chat')
          }}
        />
      ) : record !== null ? (
        <ChatScreen
          record={record}
          onRepair={() => {
            void clearPairing()
            setRecord(null)
            setStage('pair')
          }}
        />
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loading: { color: '#666' },
})
