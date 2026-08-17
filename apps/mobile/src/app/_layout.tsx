/**
 * Router root layout: loads the persisted pairing once, then routes between
 * the pair, chat, and device screens. Persistence transitions (pair/unbind)
 * run here, so routes never touch the secure store themselves.
 */

import { useEffect, useState } from 'react'
import { ActivityIndicator, StatusBar, StyleSheet, Text, View } from 'react-native'
import { Stack } from 'expo-router'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import type { PairingRecord } from '@deepseek-ai/dsh-client-mobile'
import { clearPairing, loadPairing, savePairing } from '../adapters/pairing-store'
import { PairingContext, type PairingState } from '../state/pairing'

export default function RootLayout() {
  // undefined = still loading the persisted record.
  const [record, setRecord] = useState<PairingRecord | null | undefined>(undefined)

  useEffect(() => {
    void loadPairing().then(setRecord)
  }, [])

  if (record === undefined) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.loading}>正在读取配对信息…</Text>
      </View>
    )
  }

  const pairing: PairingState = {
    record,
    paired: async (next) => {
      await savePairing(next)
      setRecord(next)
    },
    unpaired: async () => {
      await clearPairing()
      setRecord(null)
    },
  }

  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" />
      <PairingContext.Provider value={pairing}>
        <Stack screenOptions={{ headerShown: false, animation: 'fade' }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="pair" />
          <Stack.Screen name="chat" />
          <Stack.Screen name="devices" />
        </Stack>
      </PairingContext.Provider>
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  loading: { color: '#666' },
})
