/// <reference lib="webworker" />
/**
 * Clinote service worker.
 *
 * Two jobs: serve the app offline, and render a notification from data that
 * never left the device.
 *
 * A push payload contains only `{ kind, ref }` (docs/notifications.md §2). The
 * sentence a person reads is built here, from this device's own database — so
 * the push service, and Clinote's servers, never see who the appointment is
 * with.
 */
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

declare const self: ServiceWorkerGlobalScope

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// Deep links resolve to the app shell; the router takes it from there.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/'), { denylist: [/^\/api\//] }))

self.addEventListener('message', (event) => {
  // The update is applied when the user asks, never behind their back
  // (docs/deployment.md §5).
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting()
})

interface PushPayload {
  kind: string
  ref?: string
}

self.addEventListener('push', (event) => {
  event.waitUntil(handlePush(event.data?.json?.() as PushPayload | undefined))
})

async function handlePush(payload: PushPayload | undefined): Promise<void> {
  const fallback = {
    title: 'Clinote',
    body: 'You have an upcoming appointment.',
  }

  if (!payload?.ref) {
    await self.registration.showNotification(fallback.title, { body: fallback.body })
    return
  }

  try {
    const details = await describeAppointment(payload.ref)
    await self.registration.showNotification(details?.title ?? fallback.title, {
      body: details?.body ?? fallback.body,
      tag: payload.ref,
      data: { url: details?.url ?? '/calendar' },
    })
  } catch {
    // Storage cleared, database upgrading, anything at all: still tell the
    // person something true rather than nothing.
    await self.registration.showNotification(fallback.title, { body: fallback.body })
  }
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data as { url?: string } | undefined)?.url ?? '/calendar'

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const existing = clients.find((client) => 'focus' in client)
      if (existing) {
        await existing.focus()
        if ('navigate' in existing) await existing.navigate(url)
        return
      }
      await self.clients.openWindow(url)
    })(),
  )
})

interface AppointmentRow {
  id: string
  clientId: string
  startAt: string
  timezone: string
  title: string
  status: string
  isDeleted: 0 | 1
  reminderRef?: string
}

interface ClientRow {
  firstName: string
  lastName: string
}

/** Reads the local database directly: Dexie would be a large dependency here. */
async function describeAppointment(
  ref: string,
): Promise<{ title: string; body: string; url: string } | null> {
  const db = await openDatabase()
  if (!db) return null

  try {
    const appointments = await readAll<AppointmentRow>(db, 'appointments')
    const appointment = appointments.find(
      (row) => row.reminderRef === ref && row.isDeleted === 0 && row.status === 'scheduled',
    )
    if (!appointment) return null

    const client = await readOne<ClientRow>(db, 'clients', appointment.clientId)
    const time = new Intl.DateTimeFormat('en-GB', {
      timeZone: appointment.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(new Date(appointment.startAt))

    const who = client ? `${client.lastName} ${client.firstName}` : 'an appointment'
    return {
      title: `${time} — ${who}`,
      body: appointment.title || 'Appointment',
      url: `/appointments/${appointment.id}`,
    }
  } finally {
    db.close()
  }
}

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    const request = indexedDB.open('clinote')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(null)
    // Never upgrade from here: the app owns the schema.
    request.onupgradeneeded = () => {
      request.transaction?.abort()
      resolve(null)
    }
  })
}

function readAll<T>(db: IDBDatabase, store: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(store)) {
      resolve([])
      return
    }
    const request = db.transaction(store).objectStore(store).getAll()
    request.onsuccess = () => resolve(request.result as T[])
    request.onerror = () => reject(request.error)
  })
}

function readOne<T>(db: IDBDatabase, store: string, key: string): Promise<T | null> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(store)) {
      resolve(null)
      return
    }
    const request = db.transaction(store).objectStore(store).get(key)
    request.onsuccess = () => resolve((request.result as T) ?? null)
    request.onerror = () => reject(request.error)
  })
}
