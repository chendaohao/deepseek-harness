import { useEffect, useRef, useState } from 'react'
import {
  VoiceChatController, type PairingRecord, type VoiceChatSnapshot,
} from '@deepseek-ai/dsh-client-mobile'
import { VoiceStore } from './state/voice'

/**
 * React binding for the voice store: one store per pairing record, created
 * and disposed with the host screen, publishing snapshots into state.
 */
export function useVoiceController(record: PairingRecord): {
  controller: VoiceChatController | null
  snapshot: VoiceChatSnapshot | null
} {
  const [snapshot, setSnapshot] = useState<VoiceChatSnapshot | null>(null)
  const storeRef = useRef<VoiceStore | null>(null)

  useEffect(() => {
    const store = new VoiceStore(record)
    store.subscribe(() => setSnapshot(store.snapshot))
    store.connect()
    storeRef.current = store
    return () => {
      store.dispose()
      storeRef.current = null
    }
  }, [record])

  return { controller: storeRef.current?.controller ?? null, snapshot }
}
