<script setup lang="ts">
/**
 * Cloud backup: health, one action, and the history behind it
 * (docs/backup.md §5, §6).
 */
import { formatBytes, formatDateTime } from '~/utils/format'

const { canUse } = useFeatureAccess()
const { isAuthenticated } = useAuth()
const { t } = useI18n()
const encryption = useEncryption()
const cloud = useCloudBackup()

const confirming = ref<string | null>(null)
const removing = ref<string | null>(null)

onMounted(async () => {
  if (cloud.ready.value) await cloud.refresh()
})

watch(cloud.ready, async (value) => {
  if (value) await cloud.refresh()
})

async function restore(id: string): Promise<void> {
  confirming.value = null
  await cloud.restore(id)
}

async function remove(id: string): Promise<void> {
  removing.value = null
  await cloud.remove(id)
}

function statusLabel(status: string): string {
  return status === 'completed' ? t('backup.kept') : t('backup.failed')
}
</script>

<template>
  <div class="card stack stack--tight">
    <div class="row">
      <h2>{{ t('backup.cloudTitle') }}</h2>
      <span
        v-if="cloud.health.value"
        class="badge"
        :class="cloud.health.value.needsAttention ? 'badge--warn' : 'badge--ok'"
      >
        {{ cloud.health.value.needsAttention ? t('backup.needsAttention') : t('backup.healthy') }}
      </span>
    </div>

    <template v-if="!canUse('cloudBackup')">
      <span class="badge badge--accent">🔒 {{ t('common.proBadge') }}</span>
      <p class="hint">{{ t('backup.cloudDescription') }}</p>
    </template>

    <template v-else-if="!isAuthenticated">
      <p class="hint">{{ t('backup.cloudSignIn') }}</p>
      <NuxtLink to="/auth/login" class="button button--primary">{{ t('common.signIn') }}</NuxtLink>
    </template>

    <template v-else-if="!encryption.isUnlocked.value">
      <p class="hint">{{ t('backup.cloudLocked') }}</p>
      <NuxtLink to="/settings" class="button">{{ t('backup.openSettings') }}</NuxtLink>
    </template>

    <template v-else>
      <dl v-if="cloud.health.value" class="details">
        <dt>{{ t('backup.lastBackup') }}</dt>
        <dd>
          {{
            cloud.health.value.lastSuccessfulBackup
              ? formatDateTime(cloud.health.value.lastSuccessfulBackup)
              : t('common.never')
          }}
        </dd>
        <dt>{{ t('backup.last30Days') }}</dt>
        <dd>
          {{
            t('backup.keptFailed', {
              kept: cloud.health.value.successCount30d,
              failed: cloud.health.value.failureCount30d,
            })
          }}
        </dd>
        <dt>{{ t('backup.storage') }}</dt>
        <dd>
          {{
            t('backup.storageUsed', {
              used: formatBytes(cloud.health.value.storageUsedBytes),
              limit: formatBytes(cloud.health.value.storageLimitBytes),
            })
          }}
        </dd>
      </dl>

      <button
        type="button"
        class="button button--primary"
        :disabled="cloud.busy.value"
        @click="cloud.backUpNow()"
      >
        {{ cloud.busy.value ? t('backup.backingUp') : t('backup.backUpNow') }}
      </button>

      <p v-if="cloud.notice.value" class="hint">{{ cloud.notice.value }}</p>

      <template v-if="cloud.backups.value.length">
        <h3 class="subhead">{{ t('backup.history') }}</h3>
        <ul class="list">
          <li v-for="backup in cloud.backups.value" :key="backup.id" class="backup">
            <div class="row">
              <span>
                <span class="list-item__title">{{ formatDateTime(backup.createdAt) }}</span>
                <br />
                <span class="list-item__meta">
                  {{ formatBytes(backup.sizeBytes) }} · {{ statusLabel(backup.status) }}
                  <template v-if="backup.expiresAt">
                    · {{ t('backup.keptUntil', { date: backup.expiresAt.slice(0, 10) }) }}
                  </template>
                </span>
              </span>
              <span v-if="backup.status !== 'completed'" class="badge badge--warn">
                {{ backup.errorCode ?? t('backup.failed') }}
              </span>
            </div>

            <div v-if="backup.status === 'completed'" class="row wrap">
              <template v-if="confirming === backup.id">
                <p class="hint warn">{{ t('backup.restoreWarning') }}</p>
                <button type="button" class="button" @click="confirming = null">
                  {{ t('common.cancel') }}
                </button>
                <button
                  type="button"
                  class="button button--danger"
                  :disabled="cloud.busy.value"
                  @click="restore(backup.id)"
                >
                  {{ t('backup.restoreYes') }}
                </button>
              </template>
              <template v-else-if="removing === backup.id">
                <button type="button" class="button" @click="removing = null">
                  {{ t('common.cancel') }}
                </button>
                <button type="button" class="button button--danger" @click="remove(backup.id)">
                  {{ t('clients.deleteYes') }}
                </button>
              </template>
              <template v-else>
                <button type="button" class="button" @click="confirming = backup.id">
                  {{ t('backup.restore') }}
                </button>
                <button type="button" class="button button--quiet" @click="removing = backup.id">
                  {{ t('common.delete') }}
                </button>
              </template>
            </div>
          </li>
        </ul>
      </template>
    </template>

    <p v-if="cloud.errorMessage.value" class="hint warn">{{ cloud.errorMessage.value }}</p>
  </div>
</template>

<style scoped>
.subhead {
  margin: var(--space-2) 0 0;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}

.backup {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.7rem 0.9rem;
  background: var(--surface-sunken);
  display: grid;
  gap: var(--space-2);
}
</style>
