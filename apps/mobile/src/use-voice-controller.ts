import { useEffect, useRef, useState } from 'react'
import {
  VoiceChatController, type PairingRecord, type VoiceChatSnapshot,
} from '@deepseek-ai/dsh-client-mobile'
import { DeviceRecognizer, DeviceSpeaker } from './adapters/speech'
import { createClient } from './adapters/transport'

/**
 * React binding for the voice controller: one controller per pairing record,
 * created and disposed with the host screen, publishing snapshots into state.
 */
export function useVoiceController(record: PairingRecord): {
  controller: VoiceChatController | null
  snapshot: VoiceChatSnapshot | null
} {
  const [snapshot, setSnapshot] = useState<VoiceChatSnapshot | null>(null)
  const controllerRef = useRef<VoiceChatController | null>(null)

  useEffect(() => {
    const controller = new VoiceChatController({
      client: createClient(record),
      recognizer: new DeviceRecognizer(),
      speaker: new DeviceSpeaker(),
      onSnapshot: setSnapshot,
    })
    controllerRef.current = controller
    controller.connect()
    return () => {
      controller.dispose()
      controllerRef.current = null
    }
  }, [record])

  return { controller: controllerRef.current, snapshot }
}
