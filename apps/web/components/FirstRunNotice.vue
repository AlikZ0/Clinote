<script setup lang="ts">
/**
 * Free onboarding (product spec §3, §52).
 *
 * A user who expects an account to mean "my data follows me" will lose work.
 * Saying it once, plainly, before there is anything to lose is the whole point.
 */
import { getLocalCore } from '~/database'

const ACK_SETTING = 'onboarding.localOnlyAcknowledgedAt'

const { t } = useI18n()
const visible = ref(false)

onMounted(async () => {
  try {
    const core = await getLocalCore()
    visible.value = !(await core.settings.get<string | null>(ACK_SETTING, null))
  } catch {
    // If the database cannot be opened the dashboard already says so.
  }
})

async function acknowledge(): Promise<void> {
  visible.value = false
  try {
    const core = await getLocalCore()
    await core.settings.set(ACK_SETTING, new Date().toISOString())
  } catch {
    // Dismissal is a convenience; failing to record it is not worth a message.
  }
}
</script>

<template>
  <div v-if="visible" class="card stack stack--tight notice">
    <h2>{{ t('onboarding.title') }}</h2>
    <p class="hint">{{ t('onboarding.body') }}</p>
    <button type="button" class="button" @click="acknowledge">
      {{ t('onboarding.acknowledge') }}
    </button>
  </div>
</template>

<style scoped>
.notice {
  border-color: var(--accent);
  background: linear-gradient(180deg, var(--accent-soft) 0%, var(--surface) 70%);
}

.notice .button {
  justify-self: start;
}
</style>
