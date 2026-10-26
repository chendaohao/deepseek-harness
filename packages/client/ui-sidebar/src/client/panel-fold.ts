/** Persisted fold state of the global panel launcher group. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/**
 * Create the fold source for the global panel launchers.
 * @returns a browser-persisted source shared by every Session in one plugin lifecycle.
 */
export function createPanelFoldStore(): SnapshotStore<boolean> {
  return createSnapshotStore(true, { persist: { name: 'dsh.sidebar.panels-expanded' } })
}
