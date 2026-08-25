/**
 * Cloud backup on this device (docs/backup.md §5).
 *
 * Requires an account, the entitlement and an unlocked passphrase. Each of
 * those is reported as itself rather than as a generic failure.
 */
import { getLocalCore } from '~/database'
import { downloadBlob } from '~/utils/download'
import { formatBytes } from '~/utils/format'
import {
  CloudBackupService,
  ExportService,
  ImportService,
  type BackupHealth,
  type CloudBackupRecord,
} from '~/services'

export function useCloudBackup() {
  const backups = useState<CloudBackupRecord[]>('cloudBackup.list', () => [])
  const health = useState<BackupHealth | null>('cloudBackup.health', () => null)
  const busy = useState('cloudBackup.busy', () => false)
  const errorMessage = useState<string | null>('cloudBackup.error', () => null)
  const notice = useState<string | null>('cloudBackup.notice', () => null)

  const { canUse } = useFeatureAccess()
  const { isAuthenticated } = useAuth()
  const encryption = useEncryption()

  const ready = computed(
    () => isAuthenticated.value && canUse('cloudBackup') && encryption.isUnlocked.value,
  )

  async function service(): Promise<CloudBackupService> {
    const core = await getLocalCore()
    const appVersion = useRuntimeConfig().public.appVersion as string
    const exports = new ExportService(core, appVersion)
    return new CloudBackupService(
      core,
      useApi(),
      exports,
      new ImportService(core, exports),
      appVersion,
    )
  }

  async function refresh(): Promise<void> {
    if (!ready.value) return
    try {
      const client = await service()
      backups.value = await client.list()
      health.value = await client.health()
      errorMessage.value = null
    } catch (error) {
      errorMessage.value = describeError(error)
    }
  }

  async function backUpNow(): Promise<void> {
    const accountKey = encryption.accountKey()
    if (!accountKey || busy.value) return

    busy.value = true
    errorMessage.value = null
    notice.value = null
    try {
      const record = await (await service()).create(accountKey)
      notice.value = useI18n().t('backup.backedUp', { size: formatBytes(record.sizeBytes) })
      await refresh()
    } catch (error) {
      errorMessage.value = describeError(error)
      await refresh()
    } finally {
      busy.value = false
    }
  }

  async function restore(backupId: string): Promise<boolean> {
    const accountKey = encryption.accountKey()
    if (!accountKey || busy.value) return false

    busy.value = true
    errorMessage.value = null
    notice.value = null
    try {
      const outcome = await (await service()).restore(backupId, accountKey)
      // The safety copy only helps if the user actually has the file.
      if (outcome.safetyCopy) downloadBlob(outcome.safetyCopy.blob, outcome.safetyCopy.filename)
      notice.value = useI18n().t('backup.restored')
      return true
    } catch (error) {
      errorMessage.value = describeError(error)
      return false
    } finally {
      busy.value = false
    }
  }

  async function remove(backupId: string): Promise<void> {
    try {
      await (await service()).remove(backupId)
      await refresh()
    } catch (error) {
      errorMessage.value = describeError(error)
    }
  }

  return { backups, health, busy, errorMessage, notice, ready, refresh, backUpNow, restore, remove }
}
