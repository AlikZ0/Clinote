# Notifications

Pro / Business (§22, §23). Two independent channels, one scheduling authority.

## 1. Minimum disclosure

The server schedules reminders but must not learn who a user's clients are (I3).
It therefore stores only:

```
reminder_schedules(id, user_id, appointment_ref, fire_at, kind, channel, state)
```

- `appointment_ref` — an opaque, per-user random id. Not the appointment's own
  id, so a database dump cannot be correlated with sync envelopes.
- No title, no client id, no notes, no duration.
- `fire_at` is a UTC instant.

This is the smallest set that allows server-side delivery, and it is exactly
what the required email copy needs ("You have 3 appointments tomorrow").

## 2. Channel split

| Channel                                | Content                                                             | Rationale                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **Push** to the user's enrolled device | may include names/times, rendered **on the device** from local data | the device already holds the data; the payload sent through the push service is a content-free trigger |
| **Email**                              | counts and times only, never names or clinical text                 | email is third-party infrastructure outside our trust boundary (§23)                                   |

Push implementation: the Web Push payload contains `{ kind, ref }` only. The
service worker looks the appointment up in IndexedDB and renders the human text
locally. If the device cannot resolve it (keys locked, data missing), the
notification degrades to "You have an upcoming appointment."

## 3. Web Push support (§22)

| Platform                    | Support                                           |
| --------------------------- | ------------------------------------------------- |
| Android Chrome              | yes                                               |
| Desktop Chrome/Edge/Firefox | yes                                               |
| iOS Safari                  | only when installed to the Home Screen, iOS 16.4+ |
| Desktop Safari              | yes, with permission                              |

Push is never assumed to be delivered. Email is the fallback channel for the
tomorrow digest, and the in-app dashboard always shows the same information.
Users can disable any channel (§61).

## 4. Email events (§23, §49, §50)

`appointment tomorrow`, `appointment soon`, `backup completed`, `backup failed`,
`restore completed`, `security alert`.

Backup emails carry date, size, file count and status — no client names, no
medical information, no images (§49). Failure emails carry a technical error code
and a retry instruction (§50).

## 5. Delivery jobs (§75, §77)

```
scheduler   → picks due reminder_schedules, enqueues delivery
push job    → sends Web Push, handles 404/410 by pruning the subscription
email job   → sends via provider, retries with exponential backoff
```

`backupStatus` and `emailStatus` are separate columns. A failed email never
turns a successful backup into a failure (§77).

## 6. Preferences (§61)

Stored server-side (they drive server-side jobs), mirrored locally for the UI:

```
appointments: { tomorrow, twoHours, thirtyMinutes } × { push, email }
backup:       { completed, failed }               × { push, email }
security:     { alerts }                          × { email }
```

Every email includes an unsubscribe path for non-transactional categories;
security alerts are transactional and always sent.

## 7. What Phase 12 shipped

| Piece                                               | Where                                                            |
| --------------------------------------------------- | ---------------------------------------------------------------- |
| Schedule rows, preferences, push subscriptions      | `0004_notifications.sql`, `apps/api/src/notifications/routes.ts` |
| Delivery, preference re-check, subscription pruning | `apps/api/src/notifications/scheduler.ts`                        |
| Email templates and the SMTP sender                 | `senders.ts`, `smtp.ts`                                          |
| Web Push sender                                     | `webpush.ts`                                                     |
| Background runner (reminders + backup retention)    | `apps/api/src/worker.ts`                                         |
| Schedule computation on the device                  | `apps/web/services/reminderService.ts`                           |
| The service worker that renders the notification    | `apps/web/service-worker/sw.ts`                                  |
| Preferences and the push switch                     | `components/NotificationsCard.vue`                               |

Details worth keeping:

- **The reference lives in the appointment record.** It is generated on the
  device, stored in the record (which is encrypted before it leaves), and is
  deliberately not the appointment id. Keeping it in the record means two
  devices schedule the _same_ reminder instead of two.
- **Preferences are re-checked at delivery time.** A schedule row written last
  week does not get to override the answer a person gave this morning.
- **Clinote owns the service worker.** The PWA module now uses
  `injectManifest`, because rendering the notification from the device's own
  database is the entire reason the push payload can stay content-free.
- **Retention runs in the same worker.** Deleting an expired backup is the same
  kind of work: something the server must do whether or not anyone opens the app.

Not verified end to end: **actual Web Push delivery**. It needs VAPID keys, a
real push service and a browser subscription. The payload construction,
preference handling and pruning of dead subscriptions are unit-tested; the
delivery itself is on the per-release manual checklist (`docs/mobile.md` §7).

## 8. Tests

Schedule row lifecycle, timezone correctness of the evening digest, push payload
containing no PII (asserted), email template snapshot assertions that fail if a
client name field is ever interpolated, and retry/backoff behaviour.
