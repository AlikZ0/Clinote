/**
 * Mutation context: the per-device state every write needs.
 *
 * The device id and the hybrid logical clock are created once and shared by all
 * repositories, so that HLCs from this device form a single monotonic sequence
 * (docs/local-first.md §7).
 */
import { HybridClock, createId, nowIso } from '@clinote/shared'
import type { ClinoteDatabase } from './db'

export const DEVICE_ID_SETTING = 'device.id'
export const HLC_SETTING = 'device.lastHlc'

export interface MutationContext {
  deviceId: string
  clock: HybridClock
  now: () => string
}

/**
 * Reads (or creates) the device id. It lives in `settings`, not localStorage:
 * localStorage and IndexedDB are evicted independently, and a device id that
 * outlives its database would make the outbox and sync cursors lie about which
 * device produced which change.
 */
export async function resolveDeviceId(db: ClinoteDatabase, shared?: string): Promise<string> {
  const existing = await db.settings.get(DEVICE_ID_SETTING)
  if (!shared && existing && typeof existing.value === 'string') return existing.value

  // A workspace database is a second database on the *same* device, so it is
  // given the device id the personal database already established. Letting it
  // mint its own would register a second device with the server and make the
  // outbox, the HLCs and the device list disagree about what this machine is.
  const deviceId = shared ?? (typeof existing?.value === 'string' ? existing.value : createId())
  if (existing?.value !== deviceId) {
    await db.settings.put({ key: DEVICE_ID_SETTING, value: deviceId, updatedAt: nowIso() })
  }
  return deviceId
}

/**
 * Restores the clock from the last HLC this device issued, so that a reload
 * cannot re-issue timestamps it already used.
 */
export async function createMutationContext(
  db: ClinoteDatabase,
  sharedDeviceId?: string,
): Promise<MutationContext> {
  const deviceId = await resolveDeviceId(db, sharedDeviceId)
  const clock = new HybridClock(deviceId)

  const lastHlc = await db.settings.get(HLC_SETTING)
  if (lastHlc && typeof lastHlc.value === 'string') {
    try {
      clock.receive(lastHlc.value)
    } catch {
      // A stored HLC beyond the accepted drift means the device clock moved
      // backwards a long way. Starting fresh is safe: ordering still resolves
      // through the wall-clock component and the device id tiebreaker.
    }
  }

  return { deviceId, clock, now: nowIso }
}

/** Persists the newest HLC so it survives a reload. Best-effort, never blocking. */
export async function rememberHlc(db: ClinoteDatabase, hlc: string): Promise<void> {
  await db.settings.put({ key: HLC_SETTING, value: hlc, updatedAt: nowIso() })
}
