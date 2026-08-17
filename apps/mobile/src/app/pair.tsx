/** Pair route: QR scan + manual URL pairing against the remote-access gate. */

import { useRouter } from 'expo-router'
import { PairingScreen } from '../screens/PairingScreen'
import { usePairing } from '../state/pairing'

export default function PairRoute() {
  const { paired } = usePairing()
  const router = useRouter()
  return (
    <PairingScreen
      onPaired={async (record) => {
        // Persistence failures reject here: the host already paired, so the
        // screen surfaces a save-failed message instead of silently losing
        // the credential.
        await paired(record)
        router.replace('/chat')
      }}
    />
  )
}
