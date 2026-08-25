<script setup lang="ts">
/**
 * Time-ordered appointments grouped by day — the agenda, and the body of the
 * day and week views (docs/appointments.md §2).
 */
import type { Appointment } from '@clinote/types'
import { groupByDay, timeInZone } from '~/utils/calendar'

const props = defineProps<{
  appointments: Appointment[]
  clientNames: Record<string, string>
  emptyMessage?: string
}>()

const { t, tag } = useI18n()
const groups = computed(() => groupByDay(props.appointments))

function dayLabel(key: string): string {
  return new Intl.DateTimeFormat(tag.value, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(`${key}T12:00:00.000Z`))
}

function statusLabel(status: Appointment['status']): string {
  switch (status) {
    case 'completed':
      return t('appointment.completed')
    case 'cancelled':
      return t('appointment.cancelled')
    case 'no_show':
      return t('appointment.noShow')
    default:
      return t('appointment.scheduled')
  }
}
</script>

<template>
  <div v-if="groups.length" class="stack">
    <section v-for="group in groups" :key="group.dayKey" class="stack stack--tight">
      <h3 class="day">{{ dayLabel(group.dayKey) }}</h3>
      <ul class="list">
        <li v-for="appointment in group.items" :key="appointment.id">
          <NuxtLink :to="`/appointments/${appointment.id}`" class="list-item">
            <span class="slot">
              <span class="slot__time">
                {{ timeInZone(appointment.startAt, appointment.timezone) }}
              </span>
              <span>
                <span class="list-item__title">
                  {{ clientNames[appointment.clientId] ?? t('common.unknown') }}
                </span>
                <br />
                <span class="list-item__meta">
                  {{ appointment.title || t('calendar.newAppointment') }}
                  <template v-if="appointment.status !== 'scheduled'">
                    · {{ statusLabel(appointment.status) }}
                  </template>
                </span>
              </span>
            </span>
            <span aria-hidden="true" class="chevron">›</span>
          </NuxtLink>
        </li>
      </ul>
    </section>
  </div>
  <p v-else class="empty">{{ emptyMessage ?? t('calendar.nothingScheduled') }}</p>
</template>

<style scoped>
.day {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}

.slot {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.slot__time {
  font-variant-numeric: tabular-nums;
  font-weight: 650;
  font-size: 0.9375rem;
  padding: 0.25rem 0.5rem;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--accent-strong);
}

.chevron {
  color: var(--text-muted);
}
</style>
