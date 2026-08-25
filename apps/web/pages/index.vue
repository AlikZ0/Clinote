<script setup lang="ts">
import type { Appointment } from '@clinote/types'
import { addDays, dayRange } from '~/utils/calendar'
import { formatDateTime } from '~/utils/format'

const { canUse } = useFeatureAccess()
const { ready, errorMessage, counts } = useLocalDatabase()
const { lastExportAt, ageDays, stale, refresh: refreshLastExport } = useLastExport()
const { t } = useI18n()

const today = ref<Appointment[]>([])
const tomorrow = ref<Appointment[]>([])
const upcoming = ref<Appointment[]>([])
const needsOutcome = ref<Appointment[]>([])
const appointmentNames = ref<Record<string, string>>({})

onMounted(async () => {
  await refreshLastExport()
  if (!canUse('appointments')) return

  try {
    const services = await useServices()
    const now = new Date()
    today.value = await services.appointments.listRange(dayRange(now))
    tomorrow.value = await services.appointments.listRange(dayRange(addDays(now, 1)))
    upcoming.value = await services.appointments.upcoming(now, 14, 5)
    needsOutcome.value = await services.appointments.needingOutcome(now)
    appointmentNames.value = await services.clients.namesByIds(
      [...today.value, ...tomorrow.value, ...upcoming.value].map((item) => item.clientId),
    )
  } catch {
    // The dashboard degrades to the local counters; the calendar page reports.
  }
})

const stats = computed(() => [
  { key: 'dashboard.clients', value: counts.value.clients },
  { key: 'dashboard.works', value: counts.value.works },
  { key: 'dashboard.files', value: counts.value.files },
  { key: 'dashboard.appointments', value: counts.value.appointments },
])
</script>

<template>
  <section class="stack">
    <header class="hero">
      <h1>{{ t('common.appName') }}</h1>
      <p class="hint">{{ t('common.tagline') }}</p>
    </header>

    <p v-if="errorMessage" class="alert" role="alert">{{ errorMessage }}</p>

    <FirstRunNotice />

    <div class="card stack stack--tight">
      <h2>{{ t('dashboard.localDatabase') }}</h2>

      <div class="stats">
        <div v-for="stat in stats" :key="stat.key" class="stat">
          <span class="stat__value">{{ stat.value }}</span>
          <span class="stat__label">{{ t(stat.key as never) }}</span>
        </div>
      </div>

      <p class="hint">
        {{ ready ? t('dashboard.storedLocally') : t('dashboard.openingDatabase') }}
      </p>

      <p v-if="lastExportAt" class="hint" :class="{ warn: stale }">
        {{ t('dashboard.lastExport', { date: formatDateTime(lastExportAt) }) }}
        <template v-if="ageDays !== null">
          {{ t('dashboard.lastExportAge', { days: ageDays }) }}
        </template>
      </p>
      <p v-else-if="stale" class="hint warn">{{ t('dashboard.neverExported') }}</p>

      <div class="actions">
        <NuxtLink to="/clients" class="button button--block">
          {{ t('dashboard.openClients') }}
        </NuxtLink>
        <NuxtLink to="/backup" class="button button--block" :class="{ 'button--primary': stale }">
          {{ t('dashboard.exportMyData') }}
        </NuxtLink>
      </div>
    </div>

    <FeatureGate
      feature="appointments"
      :title="t('dashboard.today')"
      :description="t('dashboard.todayDescription')"
    >
      <div class="card stack stack--tight">
        <h2>{{ t('dashboard.today') }}</h2>
        <AppointmentList
          :appointments="today"
          :client-names="appointmentNames"
          :empty-message="t('dashboard.nothingToday')"
        />

        <template v-if="tomorrow.length">
          <h2>{{ t('dashboard.tomorrow') }}</h2>
          <AppointmentList :appointments="tomorrow" :client-names="appointmentNames" />
        </template>

        <p v-if="upcoming.length" class="hint">
          {{ t('dashboard.upcomingCount', { count: upcoming.length }) }}
        </p>
        <p v-if="needsOutcome.length" class="hint warn">
          {{ t('dashboard.needsOutcome', { count: needsOutcome.length }) }}
          <NuxtLink to="/calendar">{{ t('dashboard.openCalendar') }}</NuxtLink>
        </p>
      </div>
    </FeatureGate>

    <SyncCard />

    <StorageGuardCard />
  </section>
</template>

<style scoped>
.hero h1 {
  font-size: 1.75rem;
  margin-bottom: var(--space-1);
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(6rem, 1fr));
  gap: var(--space-2);
}

.stat {
  display: grid;
  gap: 0.1rem;
  padding: var(--space-3);
  border-radius: var(--radius);
  background: var(--surface-sunken);
  text-align: center;
}

.stat__value {
  font-size: 1.5rem;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  line-height: 1.1;
}

.stat__label {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.actions {
  display: grid;
  gap: var(--space-2);
  margin-top: var(--space-2);
}

@media (min-width: 34rem) {
  .actions {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
