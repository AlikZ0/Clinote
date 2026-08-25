/**
 * Install prompt.
 *
 * Chromium fires `beforeinstallprompt` and lets us show it later; Safari has no
 * such API, which is why `useStorageGuard().instructions` exists as the manual
 * fallback (docs/mobile.md §2).
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

export function useInstallPrompt() {
  const available = ref(false)
  const installed = ref(false)
  let deferred: BeforeInstallPromptEvent | null = null

  function onBeforeInstallPrompt(event: Event): void {
    event.preventDefault()
    deferred = event as BeforeInstallPromptEvent
    available.value = true
  }

  function onInstalled(): void {
    installed.value = true
    available.value = false
    deferred = null
  }

  onMounted(() => {
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onInstalled)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.removeEventListener('appinstalled', onInstalled)
  })

  async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
    if (!deferred) return 'unavailable'
    await deferred.prompt()
    const { outcome } = await deferred.userChoice
    // The event can only be used once.
    deferred = null
    available.value = false
    return outcome
  }

  return { available, installed, promptInstall }
}
