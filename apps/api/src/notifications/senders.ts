/**
 * Delivery channels (docs/notifications.md §2, §4).
 *
 * Two rules hold for everything below:
 *
 *  - **email carries no client data.** Counts and times, never names, never
 *    clinical text. Email is third-party infrastructure outside our trust
 *    boundary.
 *  - **a push payload carries no data at all.** It is `{ kind, ref }`; the
 *    service worker renders the human sentence from the device's own database.
 */
import type { ReminderKind } from '@clinote/types'

export interface EmailMessage {
  to: string
  subject: string
  text: string
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>
}

export interface PushMessage {
  endpoint: string
  keys: { p256dh: string; auth: string }
  /** Serialized as JSON. Nothing here may describe a person. */
  payload: { kind: string; ref?: string; count?: number }
}

export type PushOutcome = 'sent' | 'gone' | 'failed'

export interface PushSender {
  send(message: PushMessage): Promise<PushOutcome>
}

/** Development and tests: records what would have been sent. */
export function createMemoryEmailSender() {
  const sent: EmailMessage[] = []
  return {
    sent,
    async send(message: EmailMessage) {
      sent.push(message)
    },
  }
}

export function createMemoryPushSender(outcome: PushOutcome = 'sent') {
  const sent: PushMessage[] = []
  return {
    sent,
    async send(message: PushMessage): Promise<PushOutcome> {
      sent.push(message)
      return outcome
    },
  }
}

export const REMINDER_SUBJECTS: Record<ReminderKind, string> = {
  tomorrow: 'Your appointments tomorrow',
  before: 'An appointment is coming up',
}

/**
 * The email a reminder produces.
 *
 * Deliberately vague: the server does not know who the appointment is with, and
 * this is the copy the product specification asks for (§23).
 */
export function reminderEmail(to: string, kind: ReminderKind, count: number): EmailMessage {
  const text =
    kind === 'tomorrow'
      ? [
          count === 1
            ? 'You have 1 appointment tomorrow.'
            : `You have ${count} appointments tomorrow.`,
          '',
          'Open Clinote to see the details. They are on your device, not in this email.',
        ].join('\n')
      : [
          'You have an appointment coming up.',
          '',
          'Open Clinote to see the details. They are on your device, not in this email.',
        ].join('\n')

  return { to, subject: REMINDER_SUBJECTS[kind], text }
}

export function backupEmail(
  to: string,
  outcome: 'completed' | 'failed',
  details: { sizeBytes?: number; errorCode?: string; at: string },
): EmailMessage {
  if (outcome === 'completed') {
    return {
      to,
      subject: 'Backup completed',
      text: [
        'Your Clinote backup completed successfully.',
        '',
        `Date: ${details.at}`,
        `Size: ${formatBytes(details.sizeBytes ?? 0)}`,
        'Status: kept',
      ].join('\n'),
    }
  }

  return {
    to,
    subject: 'Backup failed',
    text: [
      'Your Clinote backup did not complete.',
      '',
      `Date: ${details.at}`,
      `Reason: ${details.errorCode ?? 'unknown'}`,
      '',
      'Please open Clinote and retry.',
    ].join('\n'),
  }
}

export function securityEmail(to: string, event: string, at: string): EmailMessage {
  return {
    to,
    subject: 'Security alert for your Clinote account',
    text: [
      `A security-relevant change happened on your account: ${event}.`,
      '',
      `Date: ${at}`,
      '',
      'If this was not you, change your password immediately.',
    ].join('\n'),
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}
