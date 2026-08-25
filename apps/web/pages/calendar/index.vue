<script setup lang="ts">
/**
 * Calendar (docs/appointments.md §2).
 *
 * Agenda is the default on a phone; the grid views are for a desk.
 */
import { CALENDAR_VIEWS, dayKey, monthGrid, timeInZone, type CalendarView } from '~/utils/calendar'

const calendar = useCalendar()
const { canUse } = useFeatureAccess()
const { t, tag } = useI18n()

onMounted(() => {
  if (typeof window !== 'undefined' && window.innerWidth >= 768) calendar.view.value = 'week'
  if (canUse('calendar')) void calendar.load()
})

const todayKey = computed(() => dayKey(new Date()))

const monthCells = computed(() =>
  calendar.view.value === 'month' ? monthGrid(calendar.anchor.value) : [],
)

const weekDays = computed(() => {
  if (calendar.view.value !== 'week') return []
  const start = calendar.range.value.start
  return Array.from({ length: 7 }, (_, index) => new Date(start.getTime() + index * 86_400_000))
})

function appointmentsOn(date: Date) {
  const key = dayKey(date)
  return calendar.appointments.value.filter(
    (appointment) =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: appointment.timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date(appointment.startAt)) === key,
  )
}

function inCurrentMonth(date: Date): boolean {
  return date.getMonth() === calendar.anchor.value.getMonth()
}

const viewLabels = computed<Record<CalendarView, string>>(() => ({
  day: t('calendar.day'),
  week: t('calendar.week'),
  month: t('calendar.month'),
  agenda: t('calendar.agenda'),
}))

const weekdayNames = computed(() => {
  // Monday first, named by the active locale.
  const formatter = new Intl.DateTimeFormat(tag.value, { weekday: 'short' })
  return Array.from({ length: 7 }, (_, index) =>
    formatter.format(new Date(Date.UTC(2024, 0, 1 + index))),
  )
})
</script>

<template>
  <section class="stack">
    <div class="row">
      <h1>{{ t('calendar.title') }}</h1>
      <NuxtLink v-if="canUse('appointments')" to="/calendar/new" class="button button--primary">
        {{ t('calendar.newAppointment') }}
      </NuxtLink>
    </div>

    <FeatureGate
      feature="calendar"
      :title="t('calendar.title')"
      :description="t('calendar.lockedDescription')"
    >
      <div class="stack">
        <div class="toolbar">
          <div class="views" role="tablist" :aria-label="t('calendar.title')">
            <button
              v-for="value in CALENDAR_VIEWS"
              :key="value"
              type="button"
              role="tab"
              class="button views__button"
              :class="{ 'button--primary': calendar.view.value === value }"
              :aria-selected="calendar.view.value === value"
              @click="calendar.view.value = value"
            >
              {{ viewLabels[value] }}
            </button>
          </div>

          <div class="row nav">
            <button type="button" class="button" aria-label="Previous" @click="calendar.go(-1)">
              ‹
            </button>
            <button type="button" class="button" @click="calendar.today()">Today</button>
            <button type="button" class="button" aria-label="Next" @click="calendar.go(1)">
              ›
            </button>
          </div>
        </div>

        <p class="range">{{ calendar.label.value }}</p>
        <p v-if="calendar.errorMessage.value" class="alert" role="alert">
          {{ calendar.errorMessage.value }}
        </p>

        <template v-if="calendar.view.value === 'month'">
          <div class="month">
            <span v-for="name in weekdayNames" :key="name" class="month__head">{{ name }}</span>
            <button
              v-for="cell in monthCells"
              :key="cell.toISOString()"
              type="button"
              class="month__cell"
              :class="{
                'month__cell--muted': !inCurrentMonth(cell),
                'month__cell--today': dayKey(cell) === todayKey,
              }"
              @click="calendar.openDay(cell)"
            >
              <span class="month__day">{{ cell.getDate() }}</span>
              <span v-if="calendar.countsByDay.value[dayKey(cell)]" class="month__count">
                {{ calendar.countsByDay.value[dayKey(cell)] }}
              </span>
            </button>
          </div>
        </template>

        <template v-else-if="calendar.view.value === 'week'">
          <div class="week">
            <section v-for="day in weekDays" :key="day.toISOString()" class="week__day">
              <h3 class="week__head" :class="{ 'week__head--today': dayKey(day) === todayKey }">
                {{
                  new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric' }).format(day)
                }}
              </h3>
              <ul class="list">
                <li v-for="appointment in appointmentsOn(day)" :key="appointment.id">
                  <NuxtLink :to="`/appointments/${appointment.id}`" class="chip">
                    <strong>{{ timeInZone(appointment.startAt, appointment.timezone) }}</strong>
                    {{ calendar.clientNames.value[appointment.clientId] ?? 'Client' }}
                  </NuxtLink>
                </li>
              </ul>
              <p v-if="!appointmentsOn(day).length" class="week__empty">—</p>
            </section>
          </div>
        </template>

        <AppointmentList
          v-else
          :appointments="calendar.appointments.value"
          :client-names="calendar.clientNames.value"
          :empty-message="
            calendar.view.value === 'day'
              ? t('calendar.nothingThisDay')
              : t('calendar.nothingAhead')
          "
        />
      </div>
    </FeatureGate>
  </section>
</template>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  justify-content: space-between;
}

.views {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
}

.views__button {
  padding-inline: 0.75rem;
}

.nav {
  gap: 0.25rem;
}

.range {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.875rem;
}

.month {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 2px;
}

.month__head {
  text-align: center;
  font-size: 0.6875rem;
  color: var(--text-muted);
  padding-block: 0.25rem;
}

.month__cell {
  min-height: 56px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.125rem;
  padding: 0.25rem;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface);
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.month__cell--muted {
  opacity: 0.45;
}

.month__cell--today {
  border-color: var(--accent);
}

.month__count {
  font-size: 0.6875rem;
  padding: 0 0.375rem;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
}

.week {
  display: grid;
  gap: 0.5rem;
}

@media (min-width: 48rem) {
  .week {
    grid-template-columns: repeat(7, 1fr);
  }
}

.week__day {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.5rem;
  background: var(--surface);
  min-height: 5rem;
}

.week__head {
  margin: 0 0 0.375rem;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.week__head--today {
  color: var(--accent);
}

.week__empty {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.75rem;
}

.chip {
  display: block;
  padding: 0.25rem 0.5rem;
  border-radius: 8px;
  background: var(--surface-muted);
  color: inherit;
  text-decoration: none;
  font-size: 0.8125rem;
}
</style>
