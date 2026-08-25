/**
 * "Your data is not backed up" nudge (docs/architecture.md R1).
 *
 * On Free the exported archive is the only copy that survives a lost device, so
 * the app has to keep asking — quietly, and with the date it is basing that on.
 */
import { daysSince } from '~/utils/format'

/** After this long without an export, the dashboard starts warning. */
export const EXPORT_STALE_DAYS = 7

export function useLastExport() {
  const lastExportAt = useState<string | null>('export.lastAt', () => null)
  const loaded = useState('export.loaded', () => false)

  async function refresh(): Promise<void> {
    try {
      const services = await useServices()
      lastExportAt.value = await services.exports.lastSuccessfulExportAt()
    } catch {
      lastExportAt.value = null
    } finally {
      loaded.value = true
    }
  }

  const ageDays = computed(() =>
    lastExportAt.value === null ? null : daysSince(lastExportAt.value),
  )

  const stale = computed(
    () => loaded.value && (ageDays.value === null || ageDays.value >= EXPORT_STALE_DAYS),
  )

  return { lastExportAt, ageDays, stale, loaded, refresh }
}
