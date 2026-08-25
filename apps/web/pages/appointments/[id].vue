<script setup lang="ts">
import type { Appointment, AppointmentStatus, Client } from '@clinote/types'
import { AppointmentService } from '~/services'
import { timeInZone } from '~/utils/calendar'

const route = useRoute()
const router = useRouter()
const { t, tag } = useI18n()
const id = computed(() => String(route.params.id))

const appointment = ref<Appointment | null>(null)
const client = ref<Client | null>(null)
const loading = ref(true)
const errorMessage = ref<string | null>(null)
const confirmingDelete = ref(false)
const notes = ref('')

const outcomes: { status: AppointmentStatus; label: string }[] = [
  { status: 'completed', label: 'appointment.completed' },
  { status: 'no_show', label: 'appointment.noShow' },
  { status: 'cancelled', label: 'appointment.cancelled' },
]

const statusLabel = computed(() => {
  switch (appointment.value?.status) {
    case 'completed':
      return t('appointment.completed')
    case 'cancelled':
      return t('appointment.cancelled')
    case 'no_show':
      return t('appointment.noShow')
    default:
      return t('appointment.scheduled')
  }
})

async function load(): Promise<void> {
  loading.value = true
  try {
    const services = await useServices()
    appointment.value = await services.appointments.get(id.value)
    notes.value = appointment.value?.notes ?? ''
    client.value = appointment.value ? await services.clients.get(appointment.value.clientId) : null
  } catch (error) {
    errorMessage.value = describeError(error)
  } finally {
    loading.value = false
  }
}

async function setStatus(status: AppointmentStatus): Promise<void> {
  try {
    const services = await useServices()
    appointment.value = await services.appointments.setStatus(id.value, status)
    // A finished or cancelled appointment must stop reminding anyone.
    await withdrawIfSettled()
  } catch (error) {
    errorMessage.value = describeError(error)
  }
}

async function saveNotes(): Promise<void> {
  try {
    const services = await useServices()
    appointment.value = await services.appointments.update(id.value, { notes: notes.value })
  } catch (error) {
    errorMessage.value = describeError(error)
  }
}

async function withdrawIfSettled(): Promise<void> {
  const ref = appointment.value?.reminderRef
  if (!ref || appointment.value?.status === 'scheduled') return
  await withdrawRef(ref)
}

async function remove(): Promise<void> {
  try {
    const services = await useServices()
    const ref = appointment.value?.reminderRef
    await services.appointments.remove(id.value)
    if (ref) await withdrawRef(ref)
    await router.replace('/calendar')
  } catch (error) {
    errorMessage.value = describeError(error)
  }
}

const when = computed(() => {
  if (!appointment.value) return ''
  const start = new Date(appointment.value.startAt)
  const day = new Intl.DateTimeFormat(tag.value, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: appointment.value.timezone,
  }).format(start)
  return `${day} · ${timeInZone(appointment.value.startAt, appointment.value.timezone)}–${timeInZone(
    appointment.value.endAt,
    appointment.value.timezone,
  )}`
})

function reminderLabel(minutes: number): string {
  const known: Record<number, string> = {
    1440: 'appointment.reminderDay',
    120: 'appointment.reminderTwoHours',
    30: 'appointment.reminderThirtyMinutes',
  }
  const key = known[minutes]
  return key ? t(key as never) : t('appointment.minutes', { count: minutes })
}

const duration = computed(() =>
  appointment.value ? AppointmentService.durationOf(appointment.value) : 0,
)

/**
 * Stops the server reminding anyone about an appointment that is over.
 *
 * Best effort on purpose: a reminder is a courtesy, and failing to withdraw it
 * must never block the outcome being recorded.
 */
async function withdrawRef(ref: string): Promise<void> {
  try {
    const { ReminderService } = await import('~/services/reminderService')
    const { getLocalCore } = await import('~/database')
    await new ReminderService(await getLocalCore(), useApi()).withdraw([ref])
  } catch {
    // Nothing to do: the next publish will reconcile it.
  }
}

onMounted(load)
</script>

<template>
  <section class="stack">
    <p v-if="errorMessage" class="alert" role="alert">{{ errorMessage }}</p>

    <template v-if="appointment">
      <div class="row">
        <h1>{{ appointment.title || t('calendar.newAppointment') }}</h1>
        <span class="badge" :class="{ 'badge--ok': appointment.status === 'completed' }">
          {{ statusLabel }}
        </span>
      </div>

      <div class="card">
        <dl class="details">
          <dt>{{ t('appointment.when') }}</dt>
          <dd>{{ when }} ({{ t('appointment.minutes', { count: duration }) }})</dd>
          <dt>{{ t('appointment.client') }}</dt>
          <dd>
            <NuxtLink v-if="client" :to="`/clients/${client.id}`">
              {{ client.lastName }} {{ client.firstName }}
            </NuxtLink>
            <template v-else>{{ t('common.unknown') }}</template>
          </dd>
          <dt>{{ t('appointment.timezone') }}</dt>
          <dd>{{ appointment.timezone }}</dd>
          <dt v-if="appointment.reminderOffsetsMinutes.length">
            {{ t('appointment.reminders') }}
          </dt>
          <dd v-if="appointment.reminderOffsetsMinutes.length">
            {{ appointment.reminderOffsetsMinutes.map(reminderLabel).join(', ') }}
          </dd>
        </dl>
      </div>

      <div v-if="appointment.status === 'scheduled'" class="card stack stack--tight">
        <h2>{{ t('appointment.outcome') }}</h2>
        <div class="row wrap">
          <button
            v-for="outcome in outcomes"
            :key="outcome.status"
            type="button"
            class="button"
            @click="setStatus(outcome.status)"
          >
            {{ t(outcome.label as never) }}
          </button>
        </div>
      </div>

      <div class="card stack stack--tight">
        <h2>{{ t('appointment.notes') }}</h2>
        <textarea v-model="notes" class="textarea" />
        <button type="button" class="button" @click="saveNotes">
          {{ t('appointment.saveNotes') }}
        </button>
      </div>

      <div class="card stack stack--tight">
        <h2>{{ t('clients.dangerZone') }}</h2>
        <button
          v-if="!confirmingDelete"
          type="button"
          class="button button--danger"
          @click="confirmingDelete = true"
        >
          {{ t('appointment.deleteAction') }}
        </button>
        <div v-else class="row wrap">
          <button type="button" class="button" @click="confirmingDelete = false">
            {{ t('common.cancel') }}
          </button>
          <button type="button" class="button button--danger" @click="remove">
            {{ t('clients.deleteYes') }}
          </button>
        </div>
      </div>
    </template>

    <p v-else-if="!loading" class="empty">{{ t('appointment.notOnDevice') }}</p>
  </section>
</template>

<style scoped>
.details {
  display: grid;
  grid-template-columns: minmax(7rem, auto) 1fr;
  gap: 0.25rem 1rem;
  margin: 0;
}

.details dt {
  color: var(--text-muted);
}

.details dd {
  margin: 0;
}

.outcomes {
  flex-wrap: wrap;
  justify-content: flex-start;
}
</style>
