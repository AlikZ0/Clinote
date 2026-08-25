<script setup lang="ts">
/**
 * The R1 surface: tells the user whether their data will survive on this
 * device, and gives them the one action that fixes it.
 */
import type { StorageRisk } from '~/utils/platform'
import { formatBytes } from '~/utils/format'
import type { MessageKey } from '~/composables/useI18n'

const {
  advice,
  instructions,
  standalone,
  usageBytes,
  quotaBytes,
  quotaKnown,
  refresh,
  requestPersistence,
} = useStorageGuard()
const { available: canPromptInstall, promptInstall } = useInstallPrompt()
const { t } = useI18n()

const busy = ref(false)
const outcome = ref<string | null>(null)

onMounted(() => {
  void refresh()
})

const usageLabel = computed(() =>
  quotaKnown.value
    ? t('backup.storageUsed', {
        used: formatBytes(usageBytes.value),
        limit: formatBytes(quotaBytes.value),
      })
    : t('storage.unknownQuota'),
)

const riskLabel = computed(() =>
  advice.value.risk === 'protected'
    ? t('storage.protected')
    : advice.value.risk === 'critical'
      ? t('storage.atRisk')
      : t('storage.notGuaranteed'),
)

function riskClass(risk: StorageRisk): string {
  return risk === 'protected' ? 'badge--ok' : 'badge--warn'
}

async function onPersist(): Promise<void> {
  busy.value = true
  outcome.value = null
  try {
    outcome.value = (await requestPersistence()) ? t('storage.granted') : t('storage.declined')
  } finally {
    busy.value = false
  }
}

async function onInstall(): Promise<void> {
  const result = await promptInstall()
  if (result === 'unavailable' && instructions.value) outcome.value = instructions.value
}
</script>

<template>
  <div class="card stack stack--tight" :data-risk="advice.risk">
    <div class="row">
      <h2>{{ t(advice.titleKey as MessageKey) }}</h2>
      <span class="badge" :class="riskClass(advice.risk)">{{ riskLabel }}</span>
    </div>

    <p class="hint" :class="{ warn: advice.risk !== 'protected' }">
      {{ t(advice.messageKey as MessageKey) }}
    </p>

    <button
      v-if="advice.action === 'persist'"
      type="button"
      class="button button--primary"
      :disabled="busy"
      @click="onPersist"
    >
      {{ busy ? t('storage.asking') : t('storage.persistAction') }}
    </button>

    <template v-else-if="advice.action === 'install'">
      <button
        v-if="canPromptInstall"
        type="button"
        class="button button--primary"
        @click="onInstall"
      >
        {{ t('storage.installAction') }}
      </button>
      <p v-else-if="instructions" class="hint">{{ instructions }}</p>
    </template>

    <p v-if="outcome" class="hint">{{ outcome }}</p>

    <dl class="details">
      <dt>{{ t('storage.used') }}</dt>
      <dd>{{ usageLabel }}</dd>
      <dt>{{ t('storage.installedApp') }}</dt>
      <dd>{{ standalone ? t('common.yes') : t('common.no') }}</dd>
    </dl>
  </div>
</template>

<style scoped>
[data-risk='critical'] {
  border-color: var(--danger);
}

[data-risk='at_risk'] {
  border-color: var(--warn);
}
</style>
