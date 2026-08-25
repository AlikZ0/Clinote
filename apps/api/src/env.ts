/**
 * Environment configuration.
 *
 * Validated at boot: the process refuses to start half-configured rather than
 * failing later on the first request (docs/deployment.md §3).
 */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Comma-separated list of allowed web origins. */
  WEB_ORIGIN: z.string().default('http://localhost:3000'),

  STORAGE_DRIVER: z.enum(['memory', 'postgres']).default('memory'),
  /** Required when STORAGE_DRIVER=postgres. */
  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_MAX_CONNECTIONS: z.coerce.number().int().positive().max(100).default(10),
  /** Apply pending migrations on boot. Off in production: migrations are a
   *  deployment step that must finish before the new version serves traffic
   *  (docs/deployment.md §4). */
  DATABASE_MIGRATE_ON_BOOT: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),

  OBJECT_STORE_DRIVER: z.enum(['memory', 's3']).default('memory'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value !== 'false'),

  /** Web Push (VAPID). Push is simply unavailable when these are absent. */
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:support@clinote.app'),

  EMAIL_DRIVER: z.enum(['memory', 'smtp']).default('memory'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(1125),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  EMAIL_FROM: z.string().default('Clinote <no-reply@clinote.app>'),

  /** manual: development only, takes no money. */
  BILLING_PROVIDER: z.enum(['manual']).default('manual'),
  BILLING_WEBHOOK_SECRET: z.string().min(16).optional(),

  /** Signs access tokens. Required in production; generated per boot otherwise. */
  JWT_SECRET: z.string().min(32).optional(),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().max(365).default(30),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().int().positive().max(1440).default(30),

  /**
   * How many reverse proxies sit in front of this process.
   *
   * `request.ip` is what the rate limiter buckets by and what the audit log
   * records, so behind a load balancer with this unset every request looks
   * like it came from the balancer. Setting it to `true` is worse: the client
   * then chooses its own `X-Forwarded-For` and can forge both. The correct
   * value is the exact number of proxies you operate.
   */
  TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),

  /** Set false only for local HTTP development. */
  COOKIE_SECURE: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
})

export type Env = Omit<
  z.infer<typeof envSchema>,
  'JWT_SECRET' | 'COOKIE_SECURE' | 'DATABASE_MIGRATE_ON_BOOT' | 'S3_FORCE_PATH_STYLE'
> & {
  JWT_SECRET: string
  COOKIE_SECURE: boolean
  DATABASE_MIGRATE_ON_BOOT: boolean
  S3_FORCE_PATH_STYLE: boolean
  webOrigins: string[]
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`Invalid environment configuration:\n  ${problems.join('\n  ')}`)
  }

  const env = parsed.data

  if (env.NODE_ENV === 'production' && !env.JWT_SECRET) {
    throw new Error('JWT_SECRET is required in production (at least 32 characters).')
  }

  if (env.STORAGE_DRIVER === 'postgres' && !env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required when STORAGE_DRIVER=postgres.')
  }

  if (env.OBJECT_STORE_DRIVER === 's3' && !env.S3_BUCKET) {
    throw new Error('S3_BUCKET is required when OBJECT_STORE_DRIVER=s3.')
  }

  if (env.NODE_ENV === 'production' && env.BILLING_PROVIDER === 'manual') {
    throw new Error(
      'BILLING_PROVIDER=manual takes no money and grants paid features for free. It is not usable in production.',
    )
  }

  return {
    ...env,
    // A per-boot random secret in development: no shared constant can leak into
    // a deployment, and the cost is that restarting invalidates dev tokens.
    JWT_SECRET: env.JWT_SECRET ?? randomBytes(32).toString('base64url'),
    COOKIE_SECURE: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
    DATABASE_MIGRATE_ON_BOOT: env.DATABASE_MIGRATE_ON_BOOT ?? env.NODE_ENV !== 'production',
    S3_FORCE_PATH_STYLE: env.S3_FORCE_PATH_STYLE ?? true,
    // A per-boot secret in development, as with JWT_SECRET: no shared constant
    // can leak into a deployment.
    BILLING_WEBHOOK_SECRET:
      env.BILLING_WEBHOOK_SECRET ??
      (env.NODE_ENV === 'production' ? undefined : randomBytes(24).toString('hex')),
    webOrigins: env.WEB_ORIGIN.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  }
}
