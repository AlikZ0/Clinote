/**
 * Service worker registration and the update handshake.
 *
 * Clinote owns this rather than delegating it to the PWA module's plugin: the
 * offline guarantee is the product (docs/local-first.md §1), so registration
 * has to be code we can read, test and reason about — not a build-time
 * side effect. The module still generates `sw.js` and the manifest.
 */
const SW_URL = '/sw.js'
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000

export function useServiceWorker() {
  const registered = useState('pwa.registered', () => false)
  const needRefresh = useState('pwa.needRefresh', () => false)
  const unsupported = useState('pwa.unsupported', () => false)

  function supported(): boolean {
    return typeof navigator !== 'undefined' && 'serviceWorker' in navigator
  }

  async function register(): Promise<void> {
    if (!supported()) {
      unsupported.value = true
      return
    }

    try {
      const registration = await navigator.serviceWorker.register(SW_URL, { scope: '/' })
      registered.value = true

      // A worker already waiting means an update arrived in a previous visit.
      if (registration.waiting && navigator.serviceWorker.controller) needRefresh.value = true

      registration.addEventListener('updatefound', () => {
        const installing = registration.installing
        installing?.addEventListener('statechange', () => {
          // `controller` distinguishes an update from the very first install:
          // on first install there is nothing to refresh.
          if (installing.state === 'installed' && navigator.serviceWorker.controller) {
            needRefresh.value = true
          }
        })
      })

      // Long-lived installed apps rarely reload, so poll for a new build while
      // the app is actually being looked at.
      setInterval(() => {
        if (document.visibilityState === 'visible') void registration.update()
      }, UPDATE_CHECK_INTERVAL_MS)
    } catch {
      // An unregistered worker only costs offline capability; the local
      // database and every local feature keep working.
      registered.value = false
    }
  }

  /**
   * Applied only when the user asks: swapping code under a running import or
   * backup is exactly what we must not do (docs/deployment.md §5).
   */
  async function applyUpdate(): Promise<void> {
    if (!supported()) return
    const registration = await navigator.serviceWorker.getRegistration()
    if (!registration?.waiting) {
      window.location.reload()
      return
    }

    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), {
      once: true,
    })
    registration.waiting.postMessage({ type: 'SKIP_WAITING' })
  }

  return { registered, needRefresh, unsupported, register, applyUpdate }
}
