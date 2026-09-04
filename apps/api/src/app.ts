import Fastify, { type FastifyInstance } from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
import { ZodError } from 'zod'
import { AppError, toAppError } from '@clinote/shared'
import { planSchema } from '@clinote/types'
import { registerAuthRoutes } from './auth/routes'
import { createBillingProvider, registerBillingRoutes, type BillingProvider } from './billing'
import { registerBackupRoutes } from './backups/routes'
import { registerDeviceRoutes } from './devices/routes'
import type { Env } from './env'
import { redactPaths } from './logging'
import { createStorage, type Storage } from './storage'
import { createObjectStore, type ObjectStore } from './storage/objects'
import { registerKeyRoutes } from './users/keys'
import { registerUserRoutes } from './users/routes'
import { registerNotificationRoutes } from './notifications/routes'
import { createEmailSender, type EmailSender } from './notifications'
import { registerSyncRoutes } from './sync/routes'
import { registerWorkspaceRoutes } from './workspaces/routes'
import { registerOrganizationRoutes } from './organizations/routes'
import { registerSecurityHeaders } from './plugins/security'

export interface BuildAppOptions {
  env: Env
  /** Tests supply their own adapters; nothing else should. */
  storage?: Storage
  objects?: ObjectStore
  billing?: BillingProvider
  email?: EmailSender
  /**
   * Where the logger writes. Tests use it to read back everything the process
   * logged and assert what is missing from it; nothing else should set it.
   */
  logDestination?: NodeJS.WritableStream
  onPasswordResetRequested?: (input: { userId: string; token: string }) => Promise<void> | void
}

/**
 * Builds the Fastify instance without listening, so tests can drive it with
 * `app.inject()` and the server entrypoint stays trivial.
 */
export async function buildApp({
  env,
  storage,
  objects,
  billing,
  email,
  logDestination,
  onPasswordResetRequested,
}: BuildAppOptions): Promise<FastifyInstance> {
  const backend = storage ?? (await createStorage(env))
  const stores = backend.stores
  const objectStore = objects ?? createObjectStore(env)
  const billingProvider = billing ?? createBillingProvider(env)
  // Invitations are the only mail the API itself sends; reminders belong to the
  // worker, which has its own sender and its own schedule.
  const emailSender = email ?? createEmailSender(env)
  const app = Fastify({
    logger: {
      level: logDestination ? 'trace' : env.NODE_ENV === 'test' ? 'silent' : env.LOG_LEVEL,
      redact: { paths: redactPaths, censor: '[redacted]' },
      ...(logDestination ? { stream: logDestination } : {}),
    },
    // Backups never travel through the JSON API (docs/backup.md §4), so a small
    // body limit is correct and protects the process from memory pressure.
    bodyLimit: 1_048_576,
    // Zero means "the socket address is the client". Otherwise trust exactly
    // as many hops as we operate proxies: expressed as a predicate because
    // that is the honest shape of the rule, and because `true` would let a
    // client pick its own `X-Forwarded-For` (see TRUST_PROXY in env.ts).
    trustProxy:
      env.TRUST_PROXY === 0 ? false : (_address: string, hop: number) => hop < env.TRUST_PROXY,
  })

  registerSecurityHeaders(app, { production: env.NODE_ENV === 'production' })

  /**
   * Keeps the exact bytes of a JSON body.
   *
   * A webhook signature covers what was sent, not what a re-serializer would
   * produce; verifying against `JSON.stringify(parsed)` would reject valid
   * requests and, worse, could accept altered ones.
   */
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    ;(request as unknown as { rawBody?: string }).rawBody = body as string
    try {
      done(null, body === '' ? {} : JSON.parse(body as string))
    } catch (error) {
      done(error as Error, undefined)
    }
  })

  await app.register(cookie)

  await app.register(cors, {
    origin: env.webOrigins,
    // The refresh cookie only travels with credentialed requests.
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-clinote-device',
      // Which workspace a request is about. Missing here, every cross-origin
      // call from a browser in a workspace fails the preflight.
      'x-clinote-workspace',
    ],
  })

  await app.register(rateLimit, {
    global: true,
    max: env.NODE_ENV === 'test' ? 10_000 : 300,
    timeWindow: '1 minute',
  })

  app.setErrorHandler((error, request, reply) => {
    // A schema rejection is the caller's mistake, not a server failure.
    const appError =
      error instanceof AppError
        ? error
        : error instanceof ZodError
          ? new AppError('validation_failed', {
              message: 'Some of the details are missing or invalid.',
              details: { fields: error.issues.map((issue) => issue.path.join('.')) },
            })
          : hasStatus(error, 429)
            ? new AppError('rate_limited', {
                message: 'Too many attempts. Please wait a moment and try again.',
              })
            : hasStatus(error, 413)
              ? new AppError('validation_failed', {
                  message: 'That request is too large.',
                })
              : toAppError(error)
    const status = statusFor(appError, transportStatus(error))
    if (status >= 500) request.log.error({ err: error, code: appError.code }, 'request failed')
    else request.log.warn({ code: appError.code }, 'request rejected')

    reply.status(status).send({
      error: {
        code: appError.code,
        // 5xx messages are generic: internal detail never reaches a client.
        message: status >= 500 ? 'Something went wrong. Please try again.' : appError.message,
        details: status >= 500 ? {} : appError.details,
      },
    })
  })

  app.setNotFoundHandler((_request, reply) => {
    reply.status(404).send({
      error: { code: 'not_found', message: 'Resource not found', details: {} },
    })
  })

  app.get('/health/live', async () => ({ status: 'ok' }))

  app.get('/health/ready', async (_request, reply) => {
    const database = await backend.healthy()
    // A dependency that is down means not ready, not "ok with a note": a load
    // balancer must be able to act on this (docs/deployment.md §7).
    if (!database) reply.status(503)
    return {
      status: database ? 'ok' : 'degraded',
      checks: { api: 'ok', database: database ? 'ok' : 'unavailable' },
    }
  })

  /**
   * Plan catalog. Prices, quotas and retention are data, never frontend
   * constants (product spec §7): this reads the `plans` table, so changing a
   * price is a database change and not a release.
   */
  app.get('/api/v1/plans', async (_request, reply) => {
    reply.header('cache-control', 'public, max-age=300')
    return (await stores.plans.listPublic()).map((plan) => planSchema.parse(plan))
  })

  // Owned connections are closed with the app; injected ones belong to the caller.
  if (!storage) app.addHook('onClose', () => backend.close())

  await registerAuthRoutes(app, { env, stores, onPasswordResetRequested })
  await registerUserRoutes(app, { env, stores })
  await registerDeviceRoutes(app, { env, stores })
  await registerKeyRoutes(app, { env, stores })
  await registerSyncRoutes(app, { env, stores })
  await registerBackupRoutes(app, { env, stores, objects: objectStore })
  await registerNotificationRoutes(app, { env, stores })
  await registerWorkspaceRoutes(app, { env, stores, email: emailSender })
  await registerOrganizationRoutes(app, { env, stores, email: emailSender })
  await registerBillingRoutes(app, {
    env,
    stores,
    billing: stores.billing,
    provider: billingProvider,
  })

  return app
}

/** A 4xx Fastify raised before any of our code ran: body too large, bad JSON. */
function transportStatus(error: unknown): number | undefined {
  const status = (error as { statusCode?: number }).statusCode
  return status !== undefined && status >= 400 && status < 500 && status !== 429
    ? status
    : undefined
}

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    (error as { statusCode?: number }).statusCode === status
  )
}

function statusFor(error: AppError, fallback?: number): number {
  // Fastify's own transport-level refusals already carry the right status.
  // Flattening them into 500 would tell a client the server broke when it was
  // the request that was wrong, and would file a false server error in the log.
  if (fallback !== undefined) return fallback

  switch (error.code) {
    case 'unauthenticated':
      return 401
    case 'forbidden':
    case 'feature_not_available':
      return 403
    case 'not_found':
      return 404
    // Both are absences, not server failures: encryption has not been set up,
    // or nobody has granted this member the workspace key yet.
    case 'key_unavailable':
    case 'workspace_key_unavailable':
      return 404
    case 'validation_failed':
      return 422
    // The upload is unusable. Not a server failure, and not something a
    // different request body would fix — the artifact itself is wrong.
    case 'backup_invalid_format':
    case 'backup_checksum_mismatch':
    case 'backup_version_unsupported':
      return 400
    case 'sync_conflict':
      return 409
    case 'device_limit_reached':
    case 'storage_limit_reached':
    case 'member_limit_reached':
    case 'workspace_limit_reached':
      return 402
    // A used, expired or mismatched invite. Nothing to retry, nothing to fix
    // in the request — a new invite is needed.
    case 'invite_invalid':
      return 410
    case 'rate_limited':
      return 429
    default:
      return 500
  }
}
