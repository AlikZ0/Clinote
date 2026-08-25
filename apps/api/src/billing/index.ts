import type { Env } from '../env'
import { createManualBillingProvider } from './manual'
import type { BillingProvider } from './provider'

export * from './provider'
export { createManualBillingProvider, signWebhook } from './manual'
export { BillingService, type BillingStores } from './service'
export { registerBillingRoutes } from './routes'

export function createBillingProvider(env: Env): BillingProvider {
  if (env.NODE_ENV === 'production') {
    // Belt and braces: `loadEnv` already refuses, and this is the second lock.
    throw new Error('No production billing provider is configured.')
  }

  if (!env.BILLING_WEBHOOK_SECRET) {
    throw new Error(
      'BILLING_WEBHOOK_SECRET is required: without it the webhook signature cannot be verified.',
    )
  }

  return createManualBillingProvider({
    webhookSecret: env.BILLING_WEBHOOK_SECRET,
    checkoutBaseUrl: `${env.webOrigins[0] ?? 'http://localhost:3000'}/billing/checkout`,
  })
}
