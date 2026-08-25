/** Billing routes (docs/api.md §9). */
import type { FastifyInstance } from 'fastify'
import { AppError } from '@clinote/shared'
import { z } from 'zod'
import type { Env } from '../env'
import { resolveEntitlement } from '../entitlements'
import { createRequireAuth, requireAuthContext } from '../plugins/authenticate'
import type { Stores } from '../storage'
import { signWebhook } from './manual'
import type { BillingProvider } from './provider'
import { BillingService, type BillingStores } from './service'

const checkoutSchema = z.object({
  planId: z.string().min(1).max(64),
  interval: z.enum(['month', 'year']).default('month'),
})

export async function registerBillingRoutes(
  app: FastifyInstance,
  options: {
    env: Env
    stores: Stores
    billing: BillingStores
    provider: BillingProvider
  },
): Promise<void> {
  const requireAuth = createRequireAuth(options.env.JWT_SECRET)
  const service = new BillingService(options.stores, options.billing, options.provider)
  const webOrigin = options.env.webOrigins[0] ?? 'http://localhost:3000'

  app.get('/api/v1/subscriptions/me', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const subscription = await options.stores.subscriptions.findByUserId(userId)

    return {
      subscription: subscription
        ? {
            planId: subscription.planId,
            status: subscription.status,
            currentPeriodEnd: subscription.currentPeriodEnd,
          }
        : null,
      entitlement: await resolveEntitlement(options.stores, userId),
    }
  })

  app.post('/api/v1/subscriptions/checkout', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const body = checkoutSchema.parse(request.body)

    return service.startCheckout({
      userId,
      planId: body.planId,
      interval: body.interval,
      successUrl: `${webOrigin}/settings?checkout=success`,
      cancelUrl: `${webOrigin}/settings?checkout=cancelled`,
    })
  })

  app.post('/api/v1/subscriptions/cancel', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const { subscription } = await service.cancel(userId)
    return {
      subscription: subscription && {
        planId: subscription.planId,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
      },
      entitlement: await resolveEntitlement(options.stores, userId),
    }
  })

  app.post('/api/v1/subscriptions/restore', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    return service.restore(userId)
  })

  /**
   * Completes a checkout without a payment processor.
   *
   * Development only, and refused outright anywhere else: it is the stand-in
   * provider's "pay" button, and it exists so the whole flow — checkout,
   * webhook, entitlement change — can be walked through and reviewed.
   */
  if (options.env.NODE_ENV !== 'production') {
    app.post('/api/v1/billing/dev/confirm', { preHandler: requireAuth }, async (request) => {
      const { userId } = requireAuthContext(request)
      const body = z
        .object({
          planId: z.string().min(1).max(64),
          type: z
            .enum([
              'subscription.activated',
              'subscription.renewed',
              'subscription.past_due',
              'subscription.canceled',
              'subscription.expired',
            ])
            .default('subscription.activated'),
        })
        .parse(request.body)

      const event = {
        externalId: `dev_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        type: body.type,
        userId,
        planId: body.planId,
        currentPeriodEnd: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        providerSubscriptionId: null,
      }

      // Goes through the real webhook path, signature and all: the flow being
      // exercised is the production one, minus the money.
      const raw = JSON.stringify(event)
      await service.handleWebhook(raw, signWebhook(raw, options.env.BILLING_WEBHOOK_SECRET ?? ''))

      return { entitlement: await resolveEntitlement(options.stores, userId) }
    })
  }

  /**
   * Webhook. Unauthenticated by nature — the signature is the authentication,
   * and the raw body is what was signed, so it must not be re-serialized.
   */
  app.post('/api/v1/webhooks/billing/:provider', async (request, reply) => {
    const { provider } = request.params as { provider: string }
    if (provider !== options.provider.name) {
      throw new AppError('not_found', { message: 'Unknown billing provider.' })
    }

    const raw = (request as unknown as { rawBody?: string }).rawBody ?? ''
    const signature = request.headers['x-clinote-signature']

    const result = await service.handleWebhook(
      raw,
      typeof signature === 'string' ? signature : undefined,
    )

    reply.status(200)
    return { applied: result.applied }
  })
}
