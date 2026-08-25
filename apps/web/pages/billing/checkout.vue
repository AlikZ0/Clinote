<script setup lang="ts">
/**
 * Stand-in for a payment page (docs/subscriptions.md §7).
 *
 * The development billing provider sends the browser here. It says plainly
 * what it is: no card, no money, just the same webhook the real provider would
 * send, so the whole flow can be walked through before one is connected.
 */
import type { Entitlement } from '@clinote/types'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const { setEntitlement } = useFeatureAccess()

const planId = computed(() => (typeof route.query.plan === 'string' ? route.query.plan : 'pro'))
const busy = ref(false)
const done = ref(false)
const errorMessage = ref<string | null>(null)

async function confirm(): Promise<void> {
  busy.value = true
  errorMessage.value = null
  try {
    const result = await useApi().request<{ entitlement: Entitlement }>('/billing/dev/confirm', {
      method: 'POST',
      body: { planId: planId.value },
    })
    setEntitlement(result.entitlement)
    done.value = true
  } catch (error) {
    errorMessage.value = describeError(error)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <section class="stack checkout">
    <h1>{{ t('billing.checkoutTitle') }}</h1>
    <p class="hint">{{ t('billing.checkoutBody') }}</p>

    <p v-if="errorMessage" class="alert" role="alert">{{ errorMessage }}</p>

    <div class="card stack stack--tight">
      <dl class="details">
        <dt>{{ t('settings.plans') }}</dt>
        <dd>{{ planId }}</dd>
      </dl>

      <template v-if="done">
        <p class="hint">{{ t('billing.done') }}</p>
        <button type="button" class="button button--primary" @click="router.replace('/settings')">
          {{ t('billing.backToSettings') }}
        </button>
      </template>
      <template v-else>
        <button type="button" class="button button--primary" :disabled="busy" @click="confirm">
          {{ busy ? t('billing.confirming') : t('billing.confirm') }}
        </button>
        <NuxtLink to="/settings" class="button">{{ t('common.cancel') }}</NuxtLink>
      </template>
    </div>
  </section>
</template>

<style scoped>
.checkout {
  max-width: 30rem;
  margin-inline: auto;
}
</style>
