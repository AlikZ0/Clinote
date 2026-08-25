/**
 * Exercises real SMTP delivery when a mail catcher is configured. Skipped
 * otherwise; `pnpm db:up` provides one, and so does CI.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import { createSmtpEmailSender } from './smtp'
import { backupEmail, reminderEmail, type EmailSender } from './senders'

const host = process.env.TEST_SMTP_HOST
const port = Number(process.env.TEST_SMTP_PORT ?? 1125)
const apiUrl = process.env.TEST_SMTP_API ?? 'http://127.0.0.1:8125'
const runs = Boolean(host)

let sender: EmailSender

beforeAll(() => {
  if (!runs) return
  sender = createSmtpEmailSender({
    host: host as string,
    port,
    from: 'Clinote <no-reply@clinote.test>',
  })
})

interface MailpitMessage {
  Subject: string
  To: { Address: string }[]
}

async function inbox(): Promise<MailpitMessage[]> {
  const response = await fetch(`${apiUrl}/api/v1/messages?limit=50`)
  const body = (await response.json()) as { messages?: MailpitMessage[] }
  return body.messages ?? []
}

/**
 * Waits for a message instead of assuming it has already arrived.
 *
 * Handing a message to SMTP and finding it in the catcher's index are two
 * different moments, and the gap widens when the rest of the suite is running
 * alongside. Polling makes the test wait for delivery rather than race it.
 */
async function waitForMessage(address: string, timeoutMs = 15_000): Promise<MailpitMessage> {
  const deadline = Date.now() + timeoutMs

  for (;;) {
    const found = (await inbox()).find((item) =>
      item.To.some((recipient) => recipient.Address === address),
    )
    if (found) return found
    if (Date.now() > deadline) throw new Error(`No message for ${address} within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/** Comfortably above the poll budget, so a slow catcher fails as a timeout. */
const MAIL_TEST_TIMEOUT = 25_000

describe.skipIf(!runs)('SMTP delivery', () => {
  it(
    'delivers a reminder that names nobody',
    async () => {
      const address = `probe-${Date.now()}@example.com`
      await sender.send(reminderEmail(address, 'tomorrow', 3))

      expect((await waitForMessage(address)).Subject).toBe('Your appointments tomorrow')
    },
    MAIL_TEST_TIMEOUT,
  )

  it(
    'delivers a backup failure with its code',
    async () => {
      const address = `probe-fail-${Date.now()}@example.com`
      await sender.send(
        backupEmail(address, 'failed', { errorCode: 'storage_limit_reached', at: '2026-08-25' }),
      )

      expect((await waitForMessage(address)).Subject).toBe('Backup failed')
    },
    MAIL_TEST_TIMEOUT,
  )
})
