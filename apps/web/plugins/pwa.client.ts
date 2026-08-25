/**
 * Registers the service worker once the app is running.
 *
 * Production only: a service worker in development serves stale bundles and
 * makes every change look like it did not apply.
 */
export default defineNuxtPlugin(() => {
  if (!import.meta.env.PROD) return

  const { register } = useServiceWorker()
  onNuxtReady(() => {
    void register()
  })
})
