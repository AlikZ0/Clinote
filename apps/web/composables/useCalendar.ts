/**
 * Calendar state: which window is shown, and what is in it.
 *
 * The window is decided by pure functions in `utils/calendar.ts`; this only
 * moves the anchor and loads.
 */
import type { Appointment } from '@clinote/types'
import { dayKey, rangeFor, stepRange, type CalendarView } from '~/utils/calendar'

export function useCalendar(initialView: CalendarView = 'agenda') {
  const view = ref<CalendarView>(initialView)
  const anchor = ref(new Date())
  const appointments = ref<Appointment[]>([])
  const clientNames = ref<Record<string, string>>({})
  const loading = ref(false)
  const errorMessage = ref<string | null>(null)

  const range = computed(() => rangeFor(view.value, anchor.value))

  async function load(): Promise<void> {
    loading.value = true
    errorMessage.value = null
    try {
      const services = await useServices()
      const items = await services.appointments.listRange(range.value)
      appointments.value = items
      clientNames.value = await services.clients.namesByIds(items.map((item) => item.clientId))
    } catch (error) {
      errorMessage.value = describeError(error)
      appointments.value = []
    } finally {
      loading.value = false
    }
  }

  watch([view, anchor], () => void load())

  function go(direction: -1 | 1): void {
    anchor.value = stepRange(view.value, anchor.value, direction)
  }

  function today(): void {
    anchor.value = new Date()
  }

  function openDay(date: Date): void {
    anchor.value = date
    view.value = 'day'
  }

  const label = computed(() => {
    const start = range.value.start
    switch (view.value) {
      case 'day':
        return formatDay(start)
      case 'week': {
        const end = new Date(range.value.end.getTime() - 86_400_000)
        return `${formatShort(start)} – ${formatShort(end)}`
      }
      case 'month':
        return new Intl.DateTimeFormat('en-GB', {
          month: 'long',
          year: 'numeric',
        }).format(anchor.value)
      case 'agenda':
        return `From ${formatShort(start)}`
    }
  })

  /** Appointment counts per day, for the month grid. */
  const countsByDay = computed(() => {
    const counts: Record<string, number> = {}
    for (const appointment of appointments.value) {
      const key = dayKeyOf(appointment)
      counts[key] = (counts[key] ?? 0) + 1
    }
    return counts
  })

  return {
    view,
    anchor,
    range,
    appointments,
    clientNames,
    loading,
    errorMessage,
    label,
    countsByDay,
    load,
    go,
    today,
    openDay,
    dayKey,
  }
}

function dayKeyOf(appointment: Appointment): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: appointment.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(appointment.startAt))
}

function formatDay(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date)
}

function formatShort(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(date)
}
