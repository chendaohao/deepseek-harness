/**
 * Device speech adapters: expo-speech-recognition (on-device ASR) and
 * expo-speech (on-device TTS) shaped into the core's recognizer/speaker ports.
 */

import * as Speech from 'expo-speech'
import { ExpoSpeechRecognitionModule } from 'expo-speech-recognition'
import type { RecognizerHandlers, SpeechRecognizerPort, SpeechSpeakerPort } from '@deepseek-ai/dsh-client-mobile'

const recognition = ExpoSpeechRecognitionModule

/** Result event payload surface this adapter reads. */
interface RecognitionResultEvent {
  results?: { transcript?: string }[]
  isFinal?: boolean
}

/** Error event payload surface this adapter reads. */
interface RecognitionErrorEvent {
  error?: string
  message?: string
}

/** Device recognizer over the platform speech frameworks. */
export class DeviceRecognizer implements SpeechRecognizerPort {
  private listeners: { remove(): void }[] = []
  private active = false

  get available(): boolean {
    try {
      return recognition.isRecognitionAvailable()
    } catch {
      return false
    }
  }

  async start(handlers: RecognizerHandlers, language: string): Promise<void> {
    if (this.active) return
    // A previous session may still hold listeners if the native side never
    // delivered its terminal event; drop them before the new session.
    this.teardownListeners()
    const permissions = await recognition.requestPermissionsAsync()
    if (!permissions.granted) {
      handlers.onError('需要麦克风与语音识别权限，请在系统设置中开启')
      return
    }
    let finished = false
    let lastTranscript = ''
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      this.active = false
      this.teardownListeners()
    }
    const resultListener = recognition.addListener('result', (event: RecognitionResultEvent) => {
      const transcript = event.results?.[0]?.transcript ?? ''
      if (event.isFinal === true) {
        finished = true
        release()
        handlers.onFinal(transcript)
      } else {
        lastTranscript = transcript
        handlers.onInterim(transcript)
      }
    })
    const errorListener = recognition.addListener('error', (event: RecognitionErrorEvent) => {
      finished = true
      release()
      handlers.onError(event.message ?? `识别失败（${event.error ?? '未知错误'}）`)
    })
    // The terminal events release the listeners: the native side always ends
    // a session with a final result or an end, so no listener outlives the
    // session even when the controller stops listening early.
    const endListener = recognition.addListener('end', () => {
      const text = finished ? '' : lastTranscript
      release()
      if (!finished) handlers.onFinal(text)
    })
    this.listeners = [resultListener, errorListener, endListener]
    this.active = true
    try {
      recognition.start({ lang: language, interimResults: true, continuous: false })
    } catch (error) {
      release()
      throw error
    }
  }

  async stop(): Promise<void> {
    if (!this.active) return
    // Native stop() still delivers the final result and end events; the
    // listeners release themselves on those terminals, so the caller's
    // onFinal keeps firing after a manual stop.
    try {
      recognition.stop()
    } catch {
      // The native session may already be gone; release the listeners now.
      this.active = false
      this.teardownListeners()
    }
  }

  private teardownListeners(): void {
    for (const listener of this.listeners) listener.remove()
    this.listeners = []
  }
}

/** Device speaker over the platform speech synthesizer. */
export class DeviceSpeaker implements SpeechSpeakerPort {
  speak(text: string, language: string, rate: number, pitch: number, onDone: () => void, onError: (message: string) => void): void {
    Speech.speak(text, {
      language,
      rate,
      pitch,
      onDone,
      onStopped: onDone,
      onError: () => onError('设备朗读失败'),
    })
  }

  stop(): void {
    Speech.stop()
  }
}
