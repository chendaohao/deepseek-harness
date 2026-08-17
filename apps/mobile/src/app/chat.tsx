/** Chat route: the paired voice conversation screen. */

import { Redirect, useRouter } from 'expo-router'
import { ChatScreen } from '../screens/ChatScreen'
import { usePairing } from '../state/pairing'

export default function ChatRoute() {
  const { record, unpaired } = usePairing()
  const router = useRouter()
  if (record === null) return <Redirect href="/pair" />
  return (
    <ChatScreen
      record={record}
      onRepair={() => {
        void unpaired()
        router.replace('/pair')
      }}
      onManageDevices={() => {
        router.push('/devices')
      }}
    />
  )
}
