/**
 * Auth routes (docs/api.md §2).
 *
 * The refresh token lives in an HttpOnly cookie scoped to these routes, so
 * script running on the page can never read it — and the access token, which
 * script does hold, is short-lived (docs/security.md §3).
 */
import type { FastifyInstance, FastifyReply } from 'fastify'
import { AppError } from '@clinote/shared'
import {
  forgotPasswordRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
  resetPasswordRequestSchema,
} from '@clinote/types'
import type { Env } from '../env'
import type { Stores } from '../storage'
import { AuthService, type AuthResult, type SessionContext } from './service'
import { REFRESH_COOKIE } from './tokens'
import { recordSignIn } from '../workspaces/audit'

export const REFRESH_COOKIE_PATH = '/api/v1/auth'

export interface AuthRouteOptions {
  env: Env
  stores: Stores
  /** Phase 12 replaces this with the email job; Phase 7 only needs the hook. */
  onPasswordResetRequested?: (input: { userId: string; token: string }) => Promise<void> | void
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: AuthRouteOptions,
): Promise<void> {
  const { env, stores } = options
  const service = new AuthService(stores, env)

  const strictLimit = {
    config: {
      rateLimit: { max: env.NODE_ENV === 'test' ? 1000 : 10, timeWindow: '15 minutes' },
    },
  }

  function contextOf(request: { ip: string; headers: Record<string, unknown> }): SessionContext {
    const deviceHeader = request.headers['x-clinote-device']
    return {
      ip: request.ip,
      userAgent:
        typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
      deviceId: typeof deviceHeader === 'string' ? deviceHeader : null,
    }
  }

  function sendSession(reply: FastifyReply, result: AuthResult) {
    reply.setCookie(REFRESH_COOKIE, result.refreshToken, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'strict',
      path: REFRESH_COOKIE_PATH,
      expires: result.refreshExpiresAt,
    })

    return {
      user: result.user,
      entitlement: result.entitlement,
      tokens: { accessToken: result.accessToken, expiresIn: result.expiresIn },
    }
  }

  app.post('/api/v1/auth/register', strictLimit, async (request, reply) => {
    const body = registerRequestSchema.parse(request.body)
    const result = await service.register(body, contextOf(request))
    reply.status(201)
    return sendSession(reply, result)
  })

  app.post('/api/v1/auth/login', strictLimit, async (request, reply) => {
    const body = loginRequestSchema.parse(request.body)
    const result = await service.login(body, contextOf(request))
    await recordSignIn(stores, request, result.user.id)
    return sendSession(reply, result)
  })

  app.post('/api/v1/auth/refresh', async (request, reply) => {
    const token = request.cookies[REFRESH_COOKIE]
    if (!token) {
      throw new AppError('unauthenticated', { message: 'Please sign in again.' })
    }
    const result = await service.refresh(token, contextOf(request))
    return sendSession(reply, result)
  })

  app.post('/api/v1/auth/logout', async (request, reply) => {
    await service.logout(request.cookies[REFRESH_COOKIE])
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH })
    reply.status(204)
    return null
  })

  app.post('/api/v1/auth/forgot-password', strictLimit, async (request, reply) => {
    const body = forgotPasswordRequestSchema.parse(request.body)
    const issued = await service.requestPasswordReset(body.email)
    if (issued) await options.onPasswordResetRequested?.(issued)

    // Always the same answer: whether an address has an account is not public.
    reply.status(202)
    return { status: 'accepted' }
  })

  app.post('/api/v1/auth/reset-password', strictLimit, async (request, reply) => {
    const body = resetPasswordRequestSchema.parse(request.body)
    await service.resetPassword(body.token, body.password)
    reply.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH })
    reply.status(204)
    return null
  })
}
