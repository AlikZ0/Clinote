<script setup lang="ts">
const router = useRouter()
const { ensureRequestedAfterFirstWrite } = useStorageGuard()
const { t } = useI18n()

const form = reactive({
  firstName: '',
  lastName: '',
  arrivalDate: new Date().toISOString().slice(0, 10),
  phone: '',
  email: '',
  notes: '',
})

const saving = ref(false)
const errorMessage = ref<string | null>(null)

async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  errorMessage.value = null

  try {
    const services = await useServices()
    const client = await services.clients.create({ ...form })
    // The moment the user has something to lose is the moment to ask
    // (docs/architecture.md R1).
    await ensureRequestedAfterFirstWrite()
    await router.replace(`/clients/${client.id}`)
  } catch (error) {
    errorMessage.value = describeError(error)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="stack form-page">
    <h1>{{ t('clients.createTitle') }}</h1>

    <p v-if="errorMessage" class="alert" role="alert">{{ errorMessage }}</p>

    <form class="card stack" @submit.prevent="save">
      <label class="field">
        <span>{{ t('clients.firstName') }}</span>
        <input v-model="form.firstName" class="input" required autocomplete="given-name" />
      </label>

      <label class="field">
        <span>{{ t('clients.lastName') }}</span>
        <input v-model="form.lastName" class="input" required autocomplete="family-name" />
      </label>

      <label class="field">
        <span>{{ t('clients.arrivalDate') }}</span>
        <input v-model="form.arrivalDate" class="input" type="date" required />
      </label>

      <label class="field">
        <span>{{ t('clients.phone') }} ({{ t('common.optional') }})</span>
        <input v-model="form.phone" class="input" type="tel" inputmode="tel" autocomplete="tel" />
      </label>

      <label class="field">
        <span>{{ t('clients.email') }} ({{ t('common.optional') }})</span>
        <input
          v-model="form.email"
          class="input"
          type="email"
          inputmode="email"
          autocomplete="email"
        />
      </label>

      <label class="field">
        <span>{{ t('clients.notes') }} ({{ t('common.optional') }})</span>
        <textarea v-model="form.notes" class="textarea" />
      </label>

      <button type="submit" class="button button--primary button--block" :disabled="saving">
        {{ saving ? t('common.saving') : t('common.save') }}
      </button>
      <NuxtLink to="/clients" class="button button--block">{{ t('common.cancel') }}</NuxtLink>
    </form>

    <p class="hint">{{ t('clients.savedLocally') }}</p>
  </section>
</template>

<style scoped>
.form-page {
  max-width: 34rem;
}
</style>
