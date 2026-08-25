/**
 * Web Push sender.
 *
 * A subscription the push service reports as gone is pruned rather than
 * retried forever (docs/notifications.md §5).
 */
import webpush from 'web-push'
import type { PushMessage, PushOutcome, PushSender } from './senders'

export interface WebPushOptions {
  publicKey: string
  privateKey: string
  subject: string
}

export function createWebPushSender(options: WebPushOptions): PushSender {
  webpush.setVapidDetails(options.subject, options.publicKey, options.privateKey)

  return {
    async send(message: PushMessage): Promise<PushOutcome> {
      try {
        await webpush.sendNotification(
          {
            endpoint: message.endpoint,
            keys: message.keys,
          },
          JSON.stringify(message.payload),
          { TTL: 3600 },
        )
        return 'sent'
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode
        // 404/410: the browser dropped this subscription for good.
        return status === 404 || status === 410 ? 'gone' : 'failed'
      }
    },
  }
}
