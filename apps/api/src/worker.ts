/**
 * Background work (docs/deployment.md §1, docs/notifications.md §5).
 *
 * The same image as the API, started with a different entrypoint. Reminders are
 * delivered here because a browser that is closed delivers nothing (§76), and
 * retention runs here because a backup must expire whether or not anyone opens
 * the app.
 */
import { loadEnv } from './env'
import {
  createEmailSender,
  createPushSender,
  deleteExpiredBackups,
  deliverDueReminders,
} from './notifications'
import { createStorage } from './storage'
import { createObjectStore } from './storage/objects'

const TICK_MS = 30_000

const env = loadEnv()
const storage = await createStorage(env)
const objects = createObjectStore(env)
const email = createEmailSender(env)
const push = createPushSender(env)

let running = true
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    running = false
  })
}

console.warn(`Clinote worker started (tick ${TICK_MS / 1000}s)`)

while (running) {
  try {
    const reminders = await deliverDueReminders({ stores: storage.stores, email, push })
    const retention = await deleteExpiredBackups({ stores: storage.stores, objects })

    if (reminders.delivered || reminders.failed || retention.deleted) {
      // No user id, no reference, no addresses: counts only (docs/security.md §7).
      console.warn(
        JSON.stringify({
          msg: 'worker tick',
          delivered: reminders.delivered,
          skipped: reminders.skipped,
          failed: reminders.failed,
          pruned: reminders.pruned,
          backupsExpired: retention.deleted,
        }),
      )
    }
  } catch (error) {
    console.error('worker tick failed:', error instanceof Error ? error.message : error)
  }

  await new Promise((resolve) => setTimeout(resolve, TICK_MS))
}

await storage.close()
