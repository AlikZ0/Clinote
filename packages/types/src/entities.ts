/**
 * Local core entities. These shapes are the contract between the IndexedDB
 * repositories, the export archive and the sync payload, so they are defined
 * once, here, and validated with the same schemas on both sides.
 *
 * Field sets follow the product spec §14–§17 exactly. Additional personal data
 * is deliberately NOT collected (docs/indexeddb.md §3).
 */
import { z } from 'zod'

const id = z.uuid()
const isoDateTime = z.iso.datetime()
/** Calendar date without a time component, e.g. an arrival or work date. */
const isoDate = z.iso.date()
const hlc = z.string().min(3)

/** Fields carried by every synchronizable record. */
export const recordMetaSchema = z.object({
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  deletedAt: isoDateTime.nullable().default(null),
  hlc,
})

export const clientSchema = recordMetaSchema.extend({
  id,
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  arrivalDate: isoDate,
  phone: z.string().trim().max(40).optional(),
  email: z.email().max(254).optional(),
  notes: z.string().max(20_000).optional(),
})

export const workSchema = recordMetaSchema.extend({
  id,
  clientId: id,
  date: isoDate,
  title: z.string().trim().min(1).max(200),
  description: z.string().max(20_000).default(''),
  notes: z.string().max(20_000).default(''),
})

/**
 * File metadata. The bytes live in a separate table as a Blob (never base64 —
 * product spec §16, §85) and travel to the cloud as their own encrypted object
 * (docs/sync.md §6).
 *
 * Note what is absent: whether a thumbnail exists. A preview is derived data
 * that one device may hold and another may not, so it is answered by asking
 * local storage, never by a field that would travel through sync and export
 * and be wrong on arrival.
 */
export const fileMetaSchema = recordMetaSchema.extend({
  id,
  clientId: id,
  workId: id.optional(),
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  /** SHA-256 of the original bytes: deduplication and import idempotency. */
  hash: z.string().regex(/^[0-9a-f]{64}$/),
})

export const appointmentStatuses = ['scheduled', 'completed', 'cancelled', 'no_show'] as const
export const appointmentStatusSchema = z.enum(appointmentStatuses)

export const appointmentSchema = recordMetaSchema
  .extend({
    id,
    clientId: id,
    startAt: isoDateTime,
    endAt: isoDateTime,
    /** IANA zone the appointment was booked in, so the grid is timezone-stable. */
    timezone: z.string().min(1).max(64),
    title: z.string().trim().max(200).default(''),
    notes: z.string().max(20_000).default(''),
    status: appointmentStatusSchema.default('scheduled'),
    reminderOffsetsMinutes: z.array(z.number().int().positive()).max(8).default([]),
    /**
     * Opaque reference used when telling the server *when* to remind, without
     * telling it what about (docs/notifications.md §1).
     *
     * It lives in the record — which is encrypted before it leaves the device —
     * so every device schedules the same reminder instead of duplicating it,
     * and a dump of the schedule table cannot be joined to anything.
     */
    reminderRef: z.string().min(8).max(64).optional(),
  })
  .refine((value) => Date.parse(value.endAt) > Date.parse(value.startAt), {
    message: 'endAt must be after startAt',
    path: ['endAt'],
  })

export const entityTypes = ['client', 'work', 'file', 'appointment', 'settings'] as const
export const entityTypeSchema = z.enum(entityTypes)

export type RecordMeta = z.infer<typeof recordMetaSchema>
export type Client = z.infer<typeof clientSchema>
export type Work = z.infer<typeof workSchema>
export type FileMeta = z.infer<typeof fileMetaSchema>
export type Appointment = z.infer<typeof appointmentSchema>
export type AppointmentStatus = z.infer<typeof appointmentStatusSchema>
export type EntityType = z.infer<typeof entityTypeSchema>
