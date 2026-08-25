/**
 * Online/offline indicator (product spec §69).
 *
 * Offline is a display state only — it must never gate a local operation.
 */
export type ConnectivityStatus = 'online' | 'offline'

export function useConnectivity() {
  const status = useState<ConnectivityStatus>('connectivity', () => 'online')

  onMounted(() => {
    const update = () => {
      status.value = navigator.onLine ? 'online' : 'offline'
    }
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    onBeforeUnmount(() => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    })
  })

  return { status }
}
