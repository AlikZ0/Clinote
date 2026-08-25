import type { Env } from '../env'
import { createSmtpEmailSender } from './smtp'
import { createWebPushSender } from './webpush'
import {
  createMemoryEmailSender,
  createMemoryPushSender,
  type EmailSender,
  type PushSender,
} from './senders'

export * from './senders'
export * from './scheduler'
export { createSmtpEmailSender } from './smtp'
export { createWebPushSender } from './webpush'

export function createEmailSender(env: Env): EmailSender {
  if (env.EMAIL_DRIVER === 'memory') {
    if (env.NODE_ENV === 'production') {
      throw new Error('EMAIL_DRIVER=memory is not usable in production: nothing would be sent.')
    }
    return createMemoryEmailSender()
  }

  if (!env.SMTP_HOST) throw new Error('SMTP_HOST is required when EMAIL_DRIVER=smtp.')

  return createSmtpEmailSender({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    from: env.EMAIL_FROM,
  })
}

/**
 * Push is optional infrastructure: without VAPID keys the app still works, and
 * every delivery attempt simply reports failure rather than throwing at boot.
 */
export function createPushSender(env: Env): PushSender {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return createMemoryPushSender('failed')

  return createWebPushSender({
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  })
}
