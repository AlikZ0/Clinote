<script setup lang="ts">
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const clientId = computed(() => String(route.params.id))

const form = reactive({
  firstName: '',
  lastName: '',
  arrivalDate: '',
  phone: '',
  email: '',
  notes: '',
})

const loaded = ref(false)
const saving = ref(false)
const errorMessage = ref<string | null>(null)

onMounted(async () => {
  try {
    const services = await useServices()
    const client = await services.clients.get(clientId.value)
    if (!client) return
    Object.assign(form, {
      firstName: client.firstName,
      lastName: client.lastName,
      arrivalDate: client.arrivalDate,
      phone: client.phone ?? '',
      email: client.email ?? '',
      notes: client.notes ?? '',
    })
    loaded.value = true
  } catch (error) {
    errorMessage.value = describeError(error)
  }
})

async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  errorMessage.value = null
  try {
    const services = await useServices()
    await services.clients.update(clientId.value, { ...form })
    await router.replace(`/clients/${clientId.value}`)
  } catch (error) {
    errorMessage.value = describeError(error)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="stack form-page">
    <h1>{{ t('clients.editTitle') }}</h1>

    <p v-if="errorMessage" class="alert" role="alert">{{ errorMessage }}</p>

    <form v-if="loaded" class="card stack" @submit.prevent="save">
      <label class="field">
        <span>{{ t('clients.firstName') }}</span>
        <input v-model="form.firstName" class="input" required />
      </label>
      <label class="field">
        <span>{{ t('clients.lastName') }}</span>
        <input v-model="form.lastName" class="input" required />
      </label>
      <label class="field">
        <span>{{ t('clients.arrivalDate') }}</span>
        <input v-model="form.arrivalDate" class="input" type="date" required />
      </label>
      <label class="field">
        <span>{{ t('clients.phone') }}</span>
        <input v-model="form.phone" class="input" type="tel" inputmode="tel" />
      </label>
      <label class="field">
        <span>{{ t('clients.email') }}</span>
        <input v-model="form.email" class="input" type="email" inputmode="email" />
      </label>
      <label class="field">
        <span>{{ t('clients.notes') }}</span>
        <textarea v-model="form.notes" class="textarea" />
      </label>

      <button type="submit" class="button button--primary button--block" :disabled="saving">
        {{ saving ? t('common.saving') : t('common.save') }}
      </button>
      <NuxtLink :to="`/clients/${clientId}`" class="button button--block">
        {{ t('common.cancel') }}
      </NuxtLink>
    </form>
  </section>
</template>

<style scoped>
.form-page {
  max-width: 34rem;
}
</style>
