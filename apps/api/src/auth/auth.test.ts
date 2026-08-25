import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../app'
import { loadEnv } from '../env'
import type { Storage, Stores } from '../storage'
import { closeTestStorage, createTestStorage } from '../test/storage'
import { REFRESH_COOKIE } from './tokens'

let app: FastifyInstance
let storage: Storage
let stores: Stores
let resetTokens: { userId: string; token: string }[]

const CREDENTIALS = { email: 'Anna@example.com', password: 'correct horse battery staple' }

function env() {
  return loadEnv({
    NODE_ENV: 'test',
    JWT_SECRET: 'a'.repeat(48),
    COOKIE_SECURE: 'false',
  } as NodeJS.ProcessEnv)
}

beforeEach(async () => {
  storage = await createTestStorage()
  stores = storage.stores
  resetTokens = []
  app = await buildApp({
    env: env(),
    storage,
    onPasswordResetRequested: (input) => {
      resetTokens.push(input)
    },
  })
  await app.ready()
})

afterEach(async () => {
  await app.close()
})

afterAll(closeTestStorage)

async function register(overrides: Partial<typeof CREDENTIALS> = {}) {
  return app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { ...CREDENTIALS, ...overrides },
  })
}

function refreshCookieOf(response: { cookies: { name: string; value: string }[] }): string {
  const cookie = response.cookies.find((item) => item.name === REFRESH_COOKIE)
  if (!cookie) throw new Error('no refresh cookie in response')
  return cookie.value
}

describe('register', () => {
  it('creates an account and returns a session with a Free entitlement', async () => {
    const response = await register()

    expect(response.statusCode).toBe(201)
    const body = response.json()
    expect(body.user.email).toBe('anna@example.com')
    expect(body.tokens.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/)
    expect(body.entitlement.planId).toBe('free')
    expect(body.entitlement.features.cloudSync).toBe(false)
  })

  it('never returns the password hash', async () => {
    const response = await register()
    expect(JSON.stringify(response.json())).not.toMatch(/passwordHash|\$argon2/)
  })

  it('puts the refresh token in an HttpOnly cookie, not in the body', async () => {
    const response = await register()

    const cookie = response.cookies.find((item) => item.name === REFRESH_COOKIE)
    expect(cookie).toBeDefined()
    expect(cookie?.httpOnly).toBe(true)
    expect(cookie?.sameSite?.toLowerCase()).toBe('strict')
    expect(cookie?.path).toBe('/api/v1/auth')
    expect(JSON.stringify(response.json())).not.toContain(cookie?.value ?? 'missing')
  })

  it('refuses a second account for the same email, case-insensitively', async () => {
    await register()
    const second = await register({ email: 'ANNA@example.com' })

    expect(second.statusCode).toBe(422)
    expect(second.json().error.code).toBe('validation_failed')
  })

  it('refuses a password that is too short', async () => {
    const response = await register({ password: 'short' })
    expect(response.statusCode).toBe(422)
  })

  it('stores the password hashed with argon2id', async () => {
    await register()
    const user = await stores.users.findByEmail('anna@example.com')
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/)
    expect(user?.passwordHash).not.toContain(CREDENTIALS.password)
  })
})

describe('login', () => {
  // Arrow, not a bare reference: vitest passes the test context to hooks.
  beforeEach(async () => {
    await register()
  })

  it('accepts the right password', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: CREDENTIALS,
    })
    expect(response.statusCode).toBe(200)
    expect(response.json().user.email).toBe('anna@example.com')
  })

  it('rejects the wrong password without saying which part was wrong', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { ...CREDENTIALS, password: 'not the password' },
    })
    const unknownEmail = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'nobody@example.com', password: CREDENTIALS.password },
    })

    expect(wrongPassword.statusCode).toBe(401)
    expect(unknownEmail.statusCode).toBe(401)
    // Identical answers: the response must not enumerate accounts.
    expect(unknownEmail.json()).toEqual(wrongPassword.json())
  })
})

describe('refresh rotation', () => {
  it('issues a new refresh token and invalidates the old one', async () => {
    const registered = await register()
    const first = refreshCookieOf(registered)

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: first },
    })

    expect(refreshed.statusCode).toBe(200)
    const second = refreshCookieOf(refreshed)
    expect(second).not.toBe(first)
  })

  it('revokes the whole chain when an already-used token comes back', async () => {
    const registered = await register()
    const first = refreshCookieOf(registered)

    const refreshed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: first },
    })
    const second = refreshCookieOf(refreshed)

    // Replaying the first token is either a copy or a theft.
    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: first },
    })
    expect(replay.statusCode).toBe(401)

    // ...and the token that replaced it is dead too.
    const afterReplay = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: second },
    })
    expect(afterReplay.statusCode).toBe(401)
  })

  it('rejects an unknown refresh token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: 'not-a-real-token' },
    })
    expect(response.statusCode).toBe(401)
  })

  it('rejects a request with no cookie at all', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh' })
    expect(response.statusCode).toBe(401)
  })
})

describe('logout', () => {
  it('ends the session chain and clears the cookie', async () => {
    const registered = await register()
    const token = refreshCookieOf(registered)

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      cookies: { [REFRESH_COOKIE]: token },
    })
    expect(response.statusCode).toBe(204)

    const afterLogout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: token },
    })
    expect(afterLogout.statusCode).toBe(401)
  })
})

describe('password reset', () => {
  // Arrow, not a bare reference: vitest passes the test context to hooks.
  beforeEach(async () => {
    await register()
  })

  it('answers the same whether or not the address has an account', async () => {
    const known = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: CREDENTIALS.email },
    })
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: 'nobody@example.com' },
    })

    expect(known.statusCode).toBe(202)
    expect(unknown.statusCode).toBe(202)
    expect(unknown.json()).toEqual(known.json())
    // Only the real address produced a token.
    expect(resetTokens).toHaveLength(1)
  })

  it('changes the password, works once, and ends every session', async () => {
    const session = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: CREDENTIALS,
    })
    const refreshToken = refreshCookieOf(session)

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: CREDENTIALS.email },
    })
    const token = resetTokens[0]?.token as string

    const reset = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token, password: 'a brand new passphrase' },
    })
    expect(reset.statusCode).toBe(204)

    // The new password works.
    const relogin = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { ...CREDENTIALS, password: 'a brand new passphrase' },
    })
    expect(relogin.statusCode).toBe(200)

    // The old one does not.
    const oldPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: CREDENTIALS,
    })
    expect(oldPassword.statusCode).toBe(401)

    // Sessions opened before the reset are gone.
    const oldSession = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      cookies: { [REFRESH_COOKIE]: refreshToken },
    })
    expect(oldSession.statusCode).toBe(401)

    // The link cannot be used twice.
    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token, password: 'yet another passphrase' },
    })
    expect(reuse.statusCode).toBe(422)
  })

  it('refuses an expired link', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: CREDENTIALS.email },
    })
    const issued = resetTokens[0]
    expect(issued).toBeDefined()

    const record = await stores.passwordResets.findByTokenHash(
      (await import('./tokens')).hashToken(issued!.token),
    )
    await stores.passwordResets.create({
      ...record!,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/reset-password',
      payload: { token: issued!.token, password: 'a brand new passphrase' },
    })
    expect(response.statusCode).toBe(422)
  })
})
