/**
 * SecureStore persistence for the paired host record. The pairing cookie is
 * the session credential for the remote-access gate, so it lives in the
 * platform keychain, never in plain preferences.
 */

import * as SecureStore from 'expo-secure-store'
import type { PairingRecord } from '@deepseek-ai/dsh-client-mobile'

const PAIRING_KEY = 'dsh-remote-pairing'

/** Load a persisted pairing record; malformed or missing entries read as none. */
export async function loadPairing(): Promise<PairingRecord | null> {
  try {
    const raw = await SecureStore.getItemAsync(PAIRING_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<PairingRecord>
    if (typeof parsed.baseUrl !== 'string' || typeof parsed.cookie !== 'string') return null
    return { baseUrl: parsed.baseUrl, cookie: parsed.cookie }
  } catch {
    // A torn write or keychain outage must not brick the app: re-pairing
    // recovers both.
    return null
  }
}

/** Persist a fresh pairing record. */
export async function savePairing(record: PairingRecord): Promise<void> {
  await SecureStore.setItemAsync(PAIRING_KEY, JSON.stringify(record))
}

/** Drop the pairing record (re-pair flow). */
export async function clearPairing(): Promise<void> {
  await SecureStore.deleteItemAsync(PAIRING_KEY)
}
