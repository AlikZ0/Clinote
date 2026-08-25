<script setup lang="ts">
import type { Appointment, Client, FileMeta, Work } from '@clinote/types'
import { timeInZone } from '~/utils/calendar'

const route = useRoute()
const router = useRouter()
const { ensureRequestedAfterFirstWrite } = useStorageGuard()
const { canUse } = useFeatureAccess()
const { t } = useI18n()
const clientId = computed(() => String(route.params.id))

const client = ref<Client | null>(null)
const works = ref<Work[]>([])
const files = ref<FileMeta[]>([])
const nextAppointment = ref<Appointment | null>(null)
const loading = ref(true)
const errorMessage = ref<string | null>(null)
const notice = ref<string | null>(null)
const confirmingDelete = ref(false)
const uploading = ref(false)

const workForm = reactive({
  open: false,
  date: new Date().toISOString().slice(0, 10),
  title: '',
  description: '',
  saving: false,
})

async function load(): Promise<void> {
  loading.value = true
  errorMessage.value = null
  try {
    const services = await useServices()
    client.value = await services.clients.get(clientId.value)
    if (!client.value) return

    works.value = (await services.works.listByClient(clientId.value, { limit: 50 })).items
    nextAppointment.value = canUse('appointments')
      ? await services.appointments.nextForClient(clientId.value)
      : null
    files.value = (await services.files.listByClient(clientId.value, { limit: 60 })).items
  } catch (error) {
    errorMessage.value = describeError(error)
  } finally {
    loading.value = false
  }
}

async function addWork(): Promise<void> {
  if (workForm.saving) return
  workForm.saving = true
  try {
    const services = await useServices()
    await services.works.create({
      clientId: clientId.value,
      date: workForm.date,
      title: workForm.title,
      description: workForm.description,
      notes: '',
    })
    workForm.title = ''
    workForm.description = ''
    workForm.open = false
    await load()
  } catch (error) {
    errorMessage.value = describeError(error)
  } finally {
    workForm.saving = false
  }
}

async function onFilesSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const selected = Array.from(input.files ?? [])
  input.value = ''
  if (selected.length === 0) return

  uploading.value = true
  notice.value = null
  try {
    const services = await useServices()
    const result = await services.files.addFiles(clientId.value, selected)
    if (result.added.length > 0) await ensureRequestedAfterFirstWrite()
    if (result.rejected.length > 0) {
      notice.value = result.rejected.map((item) => `${item.name}: ${item.reason}`).join(' ')
    }
    await load()
  } catch (error) {
    errorMessage.value = describeError(error)
  } finally {
    uploading.value = false
  }
}

async function removeClient(): Promise<void> {
  try {
    const services = await useServices()
    await services.clients.remove(clientId.value)
    await router.replace('/clients')
  } catch (error) {
    errorMessage.value = describeError(error)
  }
}

onMounted(load)
</script>

<template>
  <section class="stack">
    <p v-if="errorMessage" class="alert" role="alert">{{ errorMessage }}</p>

    <template v-if="client">
      <div class="row">
        <h1>{{ client.lastName }} {{ client.firstName }}</h1>
        <NuxtLink :to="`/clients/${client.id}/edit`" class="button">
          {{ t('common.edit') }}
        </NuxtLink>
      </div>

      <div class="card">
        <dl class="details">
          <dt>{{ t('clients.arrivalDate') }}</dt>
          <dd>{{ client.arrivalDate }}</dd>
          <template v-if="client.phone">
            <dt>{{ t('clients.phone') }}</dt>
            <dd>
              <a :href="`tel:${client.phone}`">{{ client.phone }}</a>
            </dd>
          </template>
          <template v-if="client.email">
            <dt>{{ t('clients.email') }}</dt>
            <dd>
              <a :href="`mailto:${client.email}`">{{ client.email }}</a>
            </dd>
          </template>
        </dl>
        <p v-if="client.notes" class="notes">{{ client.notes }}</p>
      </div>

      <div v-if="canUse('appointments')" class="card stack stack--tight">
        <div class="row">
          <h2>{{ t('calendar.nextAppointment') }}</h2>
          <NuxtLink :to="`/calendar/new?clientId=${client.id}`" class="button">
            {{ t('calendar.book') }}
          </NuxtLink>
        </div>
        <NuxtLink
          v-if="nextAppointment"
          :to="`/appointments/${nextAppointment.id}`"
          class="list-item"
        >
          <span>
            <span class="list-item__title">
              {{ timeInZone(nextAppointment.startAt, nextAppointment.timezone) }}
              · {{ nextAppointment.title || t('calendar.newAppointment') }}
            </span>
            <br />
            <span class="list-item__meta">{{ nextAppointment.startAt.slice(0, 10) }}</span>
          </span>
          <span aria-hidden="true">›</span>
        </NuxtLink>
        <p v-else class="hint">{{ t('calendar.noneScheduled') }}</p>
      </div>

      <div class="card stack stack--tight">
        <div class="row">
          <h2>{{ t('works.title') }}</h2>
          <button type="button" class="button" @click="workForm.open = !workForm.open">
            {{ workForm.open ? t('common.close') : t('works.add') }}
          </button>
        </div>

        <form v-if="workForm.open" class="stack stack--tight" @submit.prevent="addWork">
          <label class="field">
            <span>{{ t('works.date') }}</span>
            <input v-model="workForm.date" class="input" type="date" required />
          </label>
          <label class="field">
            <span>{{ t('works.name') }}</span>
            <input v-model="workForm.title" class="input" required />
          </label>
          <label class="field">
            <span>{{ t('works.description') }}</span>
            <textarea v-model="workForm.description" class="textarea" />
          </label>
          <button type="submit" class="button button--primary" :disabled="workForm.saving">
            {{ workForm.saving ? t('common.saving') : t('works.save') }}
          </button>
        </form>

        <ul v-if="works.length" class="list">
          <li v-for="work in works" :key="work.id" class="list-item">
            <span>
              <span class="list-item__title">{{ work.title }}</span>
              <br />
              <span class="list-item__meta">{{ work.date }}</span>
            </span>
          </li>
        </ul>
        <p v-else class="hint">{{ t('works.empty') }}</p>
      </div>

      <div class="card stack stack--tight">
        <div class="row">
          <h2>{{ t('files.title') }}</h2>
          <label class="button">
            {{ uploading ? t('files.adding') : t('files.add') }}
            <input
              class="visually-hidden"
              type="file"
              accept="image/*,application/pdf"
              multiple
              :disabled="uploading"
              @change="onFilesSelected"
            />
          </label>
        </div>

        <p v-if="notice" class="hint warn">{{ notice }}</p>

        <div v-if="files.length" class="grid-files">
          <NuxtLink
            v-for="file in files"
            :key="file.id"
            :to="`/files/${file.id}`"
            :title="file.name"
          >
            <FileThumbnail :file="file" />
          </NuxtLink>
        </div>
        <p v-else class="hint">{{ t('files.empty') }}</p>
      </div>

      <div class="card stack stack--tight danger">
        <h2>{{ t('clients.dangerZone') }}</h2>
        <p class="hint">{{ t('clients.deleteExplanation') }}</p>
        <button
          v-if="!confirmingDelete"
          type="button"
          class="button button--danger"
          @click="confirmingDelete = true"
        >
          {{ t('clients.deleteAction') }}
        </button>
        <template v-else>
          <p class="hint warn">
            {{ t('clients.deleteConfirm', { name: `${client.lastName} ${client.firstName}` }) }}
          </p>
          <div class="row wrap">
            <button type="button" class="button" @click="confirmingDelete = false">
              {{ t('common.cancel') }}
            </button>
            <button type="button" class="button button--danger" @click="removeClient">
              {{ t('clients.deleteYes') }}
            </button>
          </div>
        </template>
      </div>
    </template>

    <p v-else-if="!loading" class="empty">{{ t('clients.notOnDevice') }}</p>
  </section>
</template>

<style scoped>
.notes {
  margin: var(--space-3) 0 0;
  white-space: pre-wrap;
}

.danger {
  border-color: color-mix(in srgb, var(--danger) 40%, var(--border));
}
</style>
