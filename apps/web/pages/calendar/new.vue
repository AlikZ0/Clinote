<script setup lang="ts">
/**
 * Client → date → time → duration → notes → save (product spec §19).
 */
import type { Client } from '@clinote/types'
import { DURATION_PRESETS, REMINDER_OFFSETS } from '~/services'
import { deviceTimezone, timeInZone } from '~/utils/calendar'

const route = useRoute()
const router = useRouter()
const { canUse } = useFeatureAccess()
const { t } = useI18n()

const reminderLabels: Record<number, string> = {
  1440: 'appointment.reminderDay',
  120: 'appointment.reminderTwoHours',
  30: 'appointment.reminderThirtyMinutes',
}

const client = ref<Client | null>(null)
const form = reactive({
  date: new Date().toISOString().slice(0, 10),
  time: '09:00',
  durationMinutes: 30,
  title: '',
  notes: '',
  reminders: [] as number[],
})

const saving = ref(false)
const errorMessage = ref<string | null>(null)
const clashes = ref<string[]>([])

onMounted(async () => {
  const preselected = route.query.clientId
  if (typeof preselected === 'string') {
    const services = await useServices()
    client.value = await services.clients.get(preselected)
  }
  if (typeof route.query.date === 'string') form.date = route.query.date
})

const startAt = computed(() => new Date(`${form.date}T${form.time}`))

/** Warn about a clash as soon as the slot is known, not after saving. */
watch(
  () => [form.date, form.time, form.durationMinutes],
  async () => {
    clashes.value = []
    if (!canUse('appointments')) return
    const start = startAt.value
    if (Number.isNaN(start.getTime())) return

    try {
      const services = await useServices()
      const found = await services.appointments.findClashes({
        startAt: start.toISOString(),
        endAt: new Date(start.getTime() + form.durationMinutes * 60_000).toISOString(),
      })
      const names = await services.clients.namesByIds(found.map((item) => item.clientId))
      clashes.value = found.map(
        (item) =>
          `${timeInZone(item.startAt, item.timezone)} ${names[item.clientId] ?? 'another client'}`,
      )
    } catch {
      clashes.value = []
    }
  },
  { immediate: false },
)

async function save(): Promise<void> {
  if (saving.value) return
  if (!client.value) {
    errorMessage.value = t('appointment.chooseClient')
    return
  }

  saving.value = true
  errorMessage.value = null
  try {
    const services = await useServices()
    const notifications = useNotifications()
    const appointment = await services.appointments.create({
      clientId: client.value.id,
      startAt: startAt.value.toISOString(),
      durationMinutes: form.durationMinutes,
      timezone: deviceTimezone(),
      title: form.title,
      notes: form.notes,
      reminderOffsetsMinutes: [...form.reminders].sort((a, b) => b - a),
    })
    // The server needs to know *when* to remind, and nothing else.
    await notifications.republish()
    await router.replace(`/appointments/${appointment.id}`)
  } catch (error) {
    errorMessage.value = describeError(error)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="stack">
    <h1>{{ t('calendar.newAppointment') }}</h1>

    <FeatureGate
      feature="appointments"
      :title="t('dashboard.appointments')"
      :description="t('appointment.lockedDescription')"
    >
      <form class="stack" @submit.prevent="save">
        <ClientPicker v-model="client" />

        <div class="fields">
          <label class="field">
            <span>{{ t('appointment.date') }}</span>
            <input v-model="form.date" class="input" type="date" required />
          </label>
          <label class="field">
            <span>{{ t('appointment.time') }}</span>
            <input v-model="form.time" class="input" type="time" required />
          </label>
        </div>

        <fieldset class="field durations">
          <legend>{{ t('appointment.duration') }}</legend>
          <button
            v-for="preset in DURATION_PRESETS"
            :key="preset"
            type="button"
            class="button"
            :class="{ 'button--primary': form.durationMinutes === preset }"
            @click="form.durationMinutes = preset"
          >
            {{ t('appointment.minutes', { count: preset }) }}
          </button>
          <input
            v-model.number="form.durationMinutes"
            class="input duration-input"
            type="number"
            min="5"
            max="480"
            step="5"
            :aria-label="t('appointment.duration')"
          />
        </fieldset>

        <p v-if="clashes.length" class="hint warn">
          {{ t('appointment.overlaps', { list: clashes.join(', ') }) }}
        </p>

        <label class="field">
          <span>{{ t('appointment.titleField') }} ({{ t('common.optional') }})</span>
          <input v-model="form.title" class="input" />
        </label>

        <label class="field">
          <span>{{ t('appointment.notes') }} ({{ t('common.optional') }})</span>
          <textarea v-model="form.notes" class="textarea" />
        </label>

        <fieldset class="field">
          <legend>{{ t('appointment.remindMe') }}</legend>
          <label v-for="offset in REMINDER_OFFSETS" :key="offset.minutes" class="checkbox">
            <input v-model="form.reminders" type="checkbox" :value="offset.minutes" />
            <span>{{ t(reminderLabels[offset.minutes] as never) }}</span>
          </label>
          <p class="hint">{{ t('appointment.reminderNote') }}</p>
        </fieldset>

        <p v-if="errorMessage" class="alert" role="alert">{{ errorMessage }}</p>

        <button type="submit" class="button button--primary button--block" :disabled="saving">
          {{ saving ? t('common.saving') : t('appointment.save') }}
        </button>
        <NuxtLink to="/calendar" class="button button--block">{{ t('common.cancel') }}</NuxtLink>
      </form>
    </FeatureGate>
  </section>
</template>

<style scoped>
.fields {
  display: grid;
  gap: 0.75rem;
  grid-template-columns: 1fr 1fr;
}

fieldset.field {
  border: 0;
  padding: 0;
  margin: 0;
}

legend {
  font-size: 0.8125rem;
  color: var(--text-muted);
  padding: 0;
  margin-bottom: 0.375rem;
}

.durations {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}

.durations legend {
  width: 100%;
}

.duration-input {
  width: 6rem;
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 44px;
}

.checkbox input {
  min-width: 1.125rem;
  min-height: 1.125rem;
}
</style>
