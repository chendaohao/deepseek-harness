/**
 * Pairing state: the route tree's single source of truth for the bound host
 * record. The root layout loads the persisted record once and hands
 * {@link usePairing} to every route; pairing and unbinding funnel through
 * {@link PairingState.paired}/{@link PairingState.unpaired} so persistence
 * happens exactly once per transition.
 */

import { createContext, useContext } from 'react'
import type { PairingRecord } from '@deepseek-ai/dsh-client-mobile'

/** The route tree's pairing contract. */
export interface PairingState {
  /** The bound host, or null while unpaired. */
  record: PairingRecord | null
  /** Persist a fresh pairing and adopt it. */
  paired(record: PairingRecord): Promise<void>
  /** Drop the pairing credential and unbind. */
  unpaired(): Promise<void>
}

/** Provided by the root layout; null outside the route tree. */
export const PairingContext = createContext<PairingState | null>(null)

/**
 * Read the pairing state; throws outside the router layout.
 * @returns the current pairing state.
 */
export function usePairing(): PairingState {
  const value = useContext(PairingContext)
  if (value === null) throw new Error('usePairing must be used inside the router layout')
  return value
}
