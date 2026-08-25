import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppError, ERROR_CODES } from '@clinote/shared'
import { ApiClient } from './client'

function respond(status: number, body: unknown, init: ResponseInit = {}): Response {
  return new Response(body === null ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function client(deviceId: string | null = null) {
  return new ApiClient({ baseUrl: '/api/v1', deviceId: () => deviceId })
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('requests', () => {
  it('sends the access token and the device header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(respond(200, { ok: true }))
    vi.stubGlobal('fetch', fetchMock)

    const api = client('device-1')
    api.setAccessToken('token-abc')
    await api.request('/users/me')

    const [, init] = fetchMock.mock.calls[0]
    expect(init.headers.authorization).toBe('Bearer token-abc')
    expect(init.headers['x-clinote-device']).toBe('device-1')
    expect(init.credentials).toBe('include')
  })

  it('returns nothing for a 204 instead of failing to parse it', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 204 })))
    expect(await client().request('/auth/logout', { method: 'POST' })).toBeUndefined()
  })
})

describe('errors', () => {
  it('maps the API error envelope onto the shared taxonomy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        respond(402, {
          error: {
            code: 'device_limit_reached',
            message: 'Remove one to add this device.',
            details: { limit: 3 },
          },
        }),
      ),
    )

    const failure: AppError = await client()
      .request<never>('/devices', { method: 'POST' })
      .catch((error: unknown) => error as AppError)

    expect(failure).toBeInstanceOf(AppError)
    expect(failure).toMatchObject({
      code: 'device_limit_reached',
      message: 'Remove one to add this device.',
      details: { limit: 3 },
    })
  })

  it('falls back to the status when the server sends an unknown code', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(respond(403, { error: { code: 'some_future_code', message: 'No.' } })),
    )

    await expect(client().request('/devices')).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('reports an unreachable server without blaming the user', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))

    const failure: AppError = await client()
      .request<never>('/users/me')
      .catch((error: unknown) => error as AppError)

    expect(failure.code).toBe('network_unavailable')
    expect(failure.message).toMatch(/local data is unaffected/)
  })
})

describe('token refresh', () => {
  it('refreshes once on a 401 and retries the original request', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        respond(401, { error: { code: 'unauthenticated', message: 'expired' } }),
      )
      .mockResolvedValueOnce(respond(200, { tokens: { accessToken: 'fresh' } }))
      .mockResolvedValueOnce(respond(200, { user: { id: 'u1' } }))
    vi.stubGlobal('fetch', fetchMock)

    const api = client()
    api.setAccessToken('stale')
    const result = await api.request<{ user: { id: string } }>('/users/me')

    expect(result.user.id).toBe('u1')
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/auth/refresh')
    expect(fetchMock.mock.calls[2][1].headers.authorization).toBe('Bearer fresh')
  })

  it('gives up after one failed refresh instead of looping', async () => {
    // A fresh Response per call: a body can only be read once, and reusing one
    // instance would fail for a reason that has nothing to do with the client.
    const fetchMock = vi
      .fn()
      .mockImplementation(async () =>
        respond(401, { error: { code: 'unauthenticated', message: 'nope' } }),
      )
    vi.stubGlobal('fetch', fetchMock)

    const api = client()
    api.setAccessToken('stale')
    await expect(api.request('/users/me')).rejects.toMatchObject({ code: 'unauthenticated' })

    // original + refresh attempt, and no retry storm
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(api.hasAccessToken()).toBe(false)
  })

  it('rotates once when several requests fail at the same moment', async () => {
    let refreshCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) => {
        if (url.endsWith('/auth/refresh')) {
          refreshCalls += 1
          return respond(200, { tokens: { accessToken: 'fresh' } })
        }
        return refreshCalls === 0
          ? respond(401, { error: { code: 'unauthenticated', message: 'expired' } })
          : respond(200, { ok: true })
      }),
    )

    const api = client()
    api.setAccessToken('stale')
    await Promise.all([api.request('/a'), api.request('/b'), api.request('/c')])

    // Concurrent rotations look like token theft to the server.
    expect(refreshCalls).toBe(1)
  })
})

describe('error taxonomy', () => {
  it('preserves every code the shared taxonomy defines', async () => {
    for (const code of ERROR_CODES) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(respond(400, { error: { code, message: 'x' } })),
      )
      await expect(client().request(`/probe/${code}`)).rejects.toMatchObject({ code })
    }
  })
})
