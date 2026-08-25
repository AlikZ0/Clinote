# Appointments and calendar

Pro / Business only (§17). Free sees the upgrade surface described in §56, never
an empty page.

## 1. Entity

```
id, clientId, startAt, endAt, title, notes,
status: scheduled | completed | cancelled | no_show,
createdAt, updatedAt, deletedAt, hlc
```

`startAt`/`endAt` are stored as UTC instants plus the IANA timezone the
appointment was created in, so a trip across timezones does not move existing
appointments in the calendar grid.

## 2. Views (§18)

- **Day** — hour grid, current-time marker.
- **Week** — 7 columns, compressed on narrow screens.
- **Month** — density dots, tap a day to open its agenda.
- **Agenda** — the default on mobile: a scrolling list grouped by day, starting
  at today.
- Dashboard slices: today, tomorrow, upcoming.

Queries are index-backed (`[status+startAt]`, `[clientId+startAt]`); a month view
loads exactly its range.

## 3. Creation flow (§19)

```
Client → New appointment → date → time → duration → notes → Save
```

Duration presets (15/30/45/60/90) plus a custom value; `endAt` is derived.
Overlap with an existing `scheduled` appointment produces a warning, not a block —
double-booking is sometimes intentional in a real practice.

## 4. Reminders (§20, §21)

Per-appointment offsets, multi-select: `1 day`, `2 hours`, `30 minutes` before,
plus the daily **Tomorrow** digest sent each evening:

```
Tomorrow
09:30 — Anna
11:00 — Ivan
14:30 — Sergey
```

The digest above is what the **push notification on the user's own device** may
show, because that device holds the decryption keys and the user owns the data.
The **email** never contains names (§23) — it says "You have 3 appointments
tomorrow." The split is implemented in `notifications.md`.

## 5. Scheduling responsibility

Frontend timers are not a scheduling mechanism (§76). When an appointment with
reminders is created or changed, the client pushes _schedule rows_ — instants
only, no identity — to the API, which owns delivery. Deleting or cancelling an
appointment withdraws its schedule rows in the same operation.

## 6. Status transitions

```
scheduled → completed | cancelled | no_show
completed → (terminal, editable notes only)
```

Past `scheduled` appointments are surfaced on the dashboard as "needs outcome"
so the calendar does not silently accumulate stale entries.

## 7. Client linkage

The client page shows the next appointment (§60) and history. Deleting a client
soft-deletes their future appointments and withdraws the corresponding schedule
rows.

## 8. What Phase 6 shipped

| Piece                                                      | Where                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------- |
| Date arithmetic, timezone placement, grouping, overlap     | `utils/calendar.ts` (pure, unit-tested)                 |
| Use cases, clash detection, status rules                   | `services/appointmentService.ts`                        |
| Day / week / month / agenda                                | `pages/calendar/index.vue`                              |
| Booking flow (client -> date -> time -> duration -> notes) | `pages/calendar/new.vue`, `components/ClientPicker.vue` |
| Appointment detail, outcome, notes, delete                 | `pages/appointments/[id].vue`                           |
| Today / tomorrow / upcoming, "needs outcome"               | `pages/index.vue`                                       |
| Locked UX for Free                                         | `components/FeatureGate.vue`                            |

Two implementation notes:

**Timezone placement is decided by the appointment, not the device.** A query to
IndexedDB is widened by a day on each side (`queryWindow`), and the results are
then filtered by the day each appointment has _in the zone it was booked in_
(`withinDays`). Without the widening, an appointment booked at 02:00 Yerevan
(22:00 UTC the previous day) would vanish from its own day.

**Clashes warn, they never block.** The warning appears while the slot is being
chosen, naming who is already booked, and the save proceeds regardless.

## 9. Tests

Recurrence-free v1, so the surface is small: creation, duration derivation,
timezone stability, overlap warning, status transitions, reminder-row lifecycle
(create/update/cancel/delete), month/week/day range queries, and gating for Free.
