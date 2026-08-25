<script setup lang="ts">
/**
 * Locked-feature UX (product spec §56).
 *
 * A Free user opening a paid screen sees what it does and how to get it —
 * never an empty page and never a broken one.
 */
import type { FeatureFlag } from '@clinote/types'

const props = defineProps<{ feature: FeatureFlag; title: string; description: string }>()

const { canUse } = useFeatureAccess()
const { t } = useI18n()
const allowed = computed(() => canUse(props.feature))
</script>

<template>
  <slot v-if="allowed" />
  <div v-else class="card stack stack--tight locked">
    <div class="row">
      <h2>{{ title }}</h2>
      <span class="badge badge--accent">🔒 {{ t('common.proBadge') }}</span>
    </div>
    <p class="hint">{{ description }}</p>
    <NuxtLink to="/settings" class="button button--primary">{{ t('common.seePlans') }}</NuxtLink>
  </div>
</template>

<style scoped>
.locked {
  border-color: var(--accent);
  background: linear-gradient(180deg, var(--accent-soft) 0%, var(--surface) 60%);
}
</style>
