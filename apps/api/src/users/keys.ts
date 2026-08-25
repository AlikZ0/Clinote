/**
 * Wrapped key material (docs/api.md §3, docs/encryption.md §5).
 *
 * The server stores the KDF parameters and the *wrapped* data keys so a second
 * device can unwrap them with the user's passphrase. It cannot unwrap them
 * itself, and there is no endpoint that would let it try.
 */
import type { FastifyInstance } from 'fastify'
import { AppError } from '@clinote/shared'
import { z } from 'zod'
import type { Env } from '../env'
import { createRequireAuth, requireAuthContext } from '../plugins/authenticate'
import type { Stores } from '../storage'

const wrappedKeySchema = z.object({ iv: z.base64(), key: z.base64() })

const putKeysSchema = z.object({
  kdf: z.literal('pbkdf2-sha256'),
  salt: z.base64(),
  iterations: z.number().int().min(100_000).max(10_000_000),
  wrappedDekSync: wrappedKeySchema,
  wrappedDekRecovery: wrappedKeySchema.nullable().default(null),
})

export async function registerKeyRoutes(
  app: FastifyInstance,
  options: { env: Env; stores: Stores },
): Promise<void> {
  const requireAuth = createRequireAuth(options.env.JWT_SECRET)
  const { stores } = options

  app.get('/api/v1/users/me/keys', { preHandler: requireAuth }, async (request) => {
    const { userId } = requireAuthContext(request)
    const record = await stores.keys.find(userId)
    if (!record) {
      throw new AppError('key_unavailable', {
        message: 'Encryption has not been set up for this account yet.',
      })
    }

    return {
      kdf: record.kdf,
      salt: record.salt,
      iterations: record.iterations,
      wrappedDekSync: record.wrappedDekSync,
      wrappedDekRecovery: record.wrappedDekRecovery,
    }
  })

  app.put('/api/v1/users/me/keys', { preHandler: requireAuth }, async (request, reply) => {
    const { userId } = requireAuthContext(request)
    const body = putKeysSchema.parse(request.body)

    const existing = await stores.keys.find(userId)
    if (existing) {
      // Replacing key material would orphan every envelope already encrypted
      // with the old key. Rotation is a separate, deliberate flow (Phase 11).
      throw new AppError('forbidden', {
        message: 'Encryption is already set up for this account.',
      })
    }

    const now = new Date().toISOString()
    await stores.keys.put({
      userId,
      kdf: body.kdf,
      salt: body.salt,
      iterations: body.iterations,
      wrappedDekSync: body.wrappedDekSync,
      wrappedDekRecovery: body.wrappedDekRecovery,
      createdAt: now,
      updatedAt: now,
    })

    reply.status(204)
    return null
  })

  /**
   * Changing the passphrase (docs/encryption.md §7).
   *
   * The data keys themselves are unchanged — only the wrapping is — so every
   * backup and every envelope written under the old passphrase stays readable.
   *
   * The server cannot check that the caller knew the old passphrase, and does
   * not pretend to: only a client that unwrapped the data keys can produce a
   * correct new wrapping, and an authenticated caller can already delete the
   * account outright.
   */
  app.post('/api/v1/users/me/keys/rotate', { preHandler: requireAuth }, async (request, reply) => {
    const { userId } = requireAuthContext(request)
    const body = putKeysSchema.parse(request.body)

    const existing = await stores.keys.find(userId)
    if (!existing) {
      throw new AppError('key_unavailable', {
        message: 'Encryption has not been set up for this account yet.',
      })
    }

    await stores.keys.put({
      userId,
      kdf: body.kdf,
      salt: body.salt,
      iterations: body.iterations,
      wrappedDekSync: body.wrappedDekSync,
      wrappedDekRecovery: body.wrappedDekRecovery,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    })

    reply.status(204)
    return null
  })
}
