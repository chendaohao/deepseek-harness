/** Devices route: the bound-device management screen. */

import { Redirect, useRouter } from 'expo-router'
import { DeviceBindingScreen } from '../screens/DeviceBindingScreen'
import { usePairing } from '../state/pairing'

export default function DevicesRoute() {
  const { record, unpaired } = usePairing()
  const router = useRouter()
  if (record === null) return <Redirect href="/pair" />
  return (
    <DeviceBindingScreen
      record={record}
      onRepair={() => {
        void unpaired()
        router.replace('/pair')
      }}
      onUnbind={() => {
        void unpaired()
        router.replace('/pair')
      }}
    />
  )
}
