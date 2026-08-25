/**
 * Request authentication.
 *
 * Every route that touches account data calls `requireAuth`; there is no
 * ambient "logged in" state and no route that authenticates implicitly.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '@clinote/shared'
import { verifyAccessToken } from '../auth/tokens'

export interface AuthenticatedUser {
  userId: string
  sessionId: string
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: AuthenticatedUser
  }
}

export function createRequireAuth(secret: string) {
  return async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const header = request.headers.authorization
    if (!header?.startsWith('Bearer ')) {
      throw new AppError('unauthenticated', { message: 'Sign in to continue.' })
    }

    const claims = await verifyAccessToken(header.slice('Bearer '.length), secret)
    if (!claims) {
      throw new AppError('unauthenticated', {
        message: 'Your session expired. Please sign in again.',
      })
    }

    request.auth = claims
  }
}

export function requireAuthContext(request: FastifyRequest): AuthenticatedUser {
  if (!request.auth) {
    throw new AppError('unauthenticated', { message: 'Sign in to continue.' })
  }
  return request.auth
}
