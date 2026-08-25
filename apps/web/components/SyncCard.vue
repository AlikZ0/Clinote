<script setup lang="ts">
/**
 * Sync state, and what is missing when there is none.
 *
 * Nothing here is fake: with no account, no subscription or a locked device the
 * card says exactly what is missing rather than showing a hopeful spinner
 * (product spec §85). The passphrase itself lives in `EncryptionCard`.
 */
import { formatDateTime } from '~/utils/format'
import type { MessageKey } from '~/composables/useI18n'

const { canUse } = useFeatureAccess()
const { isAuthenticated } = useAuth()
const { t } = useI18n()
const encryption = useEncryption()
const sync = useSync()
const workspace = useWorkspace()

/**
 * Sync is available with a paid plan — or inside somebody else's workspace,
 * which their plan pays for. A member on the Free plan syncing their clinic's
 * records is the ordinary case, not an exception (docs/sync.md §10).
 */
const eligible = computed(
  () => isAuthenticated.value && (canUse('cloudSync') || workspace.activeId.value !== null),
)

onMounted(async () => {
  if (eligible.value) await encryption.refresh()
  await sync.refreshStatus()
})

watch(eligible, async (value) => {
  if (value) await encryption.refresh()
})

const statusLabel = computed(() => t(`sync.status${capitalize(sync.status.value)}` as MessageKey))

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
</script>

<template>
  <div class="card stack stack--tight">
    <div class="row">
      <h2>{{ t('sync.title') }}</h2>
      <span class="badge" :class="{ 'badge--ok': sync.status.value === 'synced' }">
        {{ statusLabel }}
      </span>
    </div>

    <template v-if="!eligible && !isAuthenticated">
      <p class="hint">{{ t('sync.signIn') }}</p>
      <NuxtLink to="/auth/login" class="button button--primary">{{ t('common.signIn') }}</NuxtLink>
    </template>

    <template v-else-if="!eligible">
      <span class="badge badge--accent">🔒 {{ t('common.proBadge') }}</span>
      <p class="hint">{{ t('sync.lockedDescription') }}</p>
    </template>

    <template v-else-if="encryption.state.value !== 'unlocked'">
      <p class="hint">{{ t('sync.locked') }}</p>
    </template>

    <template v-else>
      <dl class="details">
        <dt>{{ t('sync.queued') }}</dt>
        <dd class="value">{{ sync.pending.value }}</dd>
        <dt>{{ t('sync.lastSync') }}</dt>
        <dd>
          {{ sync.lastSyncAt.value ? formatDateTime(sync.lastSyncAt.value) : t('common.never') }}
        </dd>
      </dl>
      <div class="row wrap">
        <button type="button" class="button" :disabled="sync.running.value" @click="sync.syncNow()">
          {{ sync.running.value ? t('sync.syncing') : t('sync.syncNow') }}
        </button>
        <NuxtLink v-if="sync.conflicts.value > 0" to="/conflicts" class="button button--danger">
          {{ t('sync.conflicts', { count: sync.conflicts.value }) }}
        </NuxtLink>
      </div>
    </template>

    <p v-if="sync.errorMessage.value" class="hint warn">{{ sync.errorMessage.value }}</p>
  </div>
</template>
