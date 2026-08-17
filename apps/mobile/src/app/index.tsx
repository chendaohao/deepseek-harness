/** Entry route: bounce to the chat when paired, else to the pair screen. */

import { Redirect } from 'expo-router'
import { usePairing } from '../state/pairing'

export default function Index() {
  const { record } = usePairing()
  return <Redirect href={record !== null ? '/chat' : '/pair'} />
}
