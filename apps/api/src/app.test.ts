import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { buildApp } from './app'
import { loadEnv } from './env'
import { createTestStorage } from './test/storage'
import { redactPaths } from './logging'

let app: FastifyInstance

beforeAll(async () => {
  app = await buildApp({
    env: loadEnv({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    storage: await createTestStorage(),
  })
  await app.ready()
})

afterAll(async () => {
  await app.close()
})

describe('health', () => {
  it('reports liveness', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ok' })
  })

  it('reports readiness with dependency checks', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' })
    expect(response.statusCode).toBe(200)
    expect(response.json().checks).toBeDefined()
  })
})

describe('plan catalog', () => {
  it('serves the plans the frontend must not hardcode', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/plans' })
    expect(response.statusCode).toBe(200)

    const plans = response.json()
    expect(plans.map((plan: { id: string }) => plan.id)).toEqual(['free', 'pro', 'business'])
    expect(plans[1].price).toEqual({ amount: 599, currency: 'USD', interval: 'month' })
    expect(plans[1].features.cloudBackup).toBe(true)
  })
})

describe('errors', () => {
  it('returns the typed error envelope for unknown routes', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/nope' })
    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({
      error: { code: 'not_found', message: 'Resource not found', details: {} },
    })
  })
})

describe('log redaction', () => {
  it('covers every field that could carry client data or secrets', () => {
    for (const field of ['firstName', 'lastName', 'notes', 'phone', 'payload', 'refreshToken']) {
      expect(redactPaths).toContain(field)
      expect(redactPaths).toContain(`body.${field}`)
    }
  })
})
