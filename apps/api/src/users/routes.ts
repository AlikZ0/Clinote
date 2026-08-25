/** User profile and the entitlement snapshot (docs/api.md §3). */
import type { FastifyInstance } from 'fastify'
import { updateProfileRequestSchema } from '@clinote/types'
import type { Env } from '../env'
import { AuthService, toPublicUser } from '../auth/service'
import { resolveEntitlement } from '../entitlements'
import { createRequireAuth, requireAuthContext } from '../plugins/authenticate'
import type { Stores } from '../storage'

export async function registerUserRoutes(
  app: FastifyInstance,
  options: { env: Env; stores: Stores },
): Promise<void> {
  const requireAuth = createRequireAuth(options.env.JWT_SECRET)
  const service = new AuthService(options.stores, options.env)

  app.get('/api/v1/users/me', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    return service.me(userId)
  })

  app.patch('/api/v1/users/me', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const patch = updateProfileRequestSchema.parse(request.body)
    const user = await options.stores.users.update(userId, patch)
    return {
      user: toPublicUser(user),
      entitlement: await resolveEntitlement(options.stores, userId),
    }
  })
}
