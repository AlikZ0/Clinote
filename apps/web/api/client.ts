/**
 * HTTP client for the Clinote API.
 *
 * Nothing in the local-first core goes through here: this is only for the
 * cloud features (docs/architecture.md §4). A failure to reach the API is
 * never allowed to break a local operation.
 *
 * The access token lives in memory only; the refresh token is an HttpOnly
 * cookie the browser holds and script cannot read (docs/security.md §3).
 */
import { AppError, ERROR_CODES, type ErrorCode } from '@clinote/shared'

export interface ApiClientOptions {
  baseUrl: string
  /** Sent as `X-Clinote-Device` so the server can attribute a session. */
  deviceId?: () => string | null
  /**
   * Sent as `X-Clinote-Workspace`. Which dataset a sync call is about is
   * ambient, exactly like which device it comes from — putting it in the path
   * would mean threading it through every call site instead.
   */
  workspaceId?: () => string | null
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  /** Skips the refresh-and-retry dance; used by the refresh call itself. */
  skipRefresh?: boolean
  signal?: AbortSignal
}

export class ApiClient {
  private accessToken: string | null = null
  private refreshing: Promise<boolean> | null = null

  constructor(private readonly options: ApiClientOptions) {}

  setAccessToken(token: string | null): void {
    this.accessToken = token
  }

  hasAccessToken(): boolean {
    return this.accessToken !== null
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.send(path, options)

    // One retry, once: a 401 usually means the 15-minute access token expired.
    if (response.status === 401 && !options.skipRefresh) {
      const refreshed = await this.refreshOnce()
      if (refreshed) {
        // Release the body of the response we are abandoning.
        await response.body?.cancel().catch(() => undefined)
        return this.parse<T>(await this.send(path, options))
      }
    }

    return this.parse<T>(response)
  }

  /**
   * Exchanges the refresh cookie for a new access token. Single-flight: a page
   * that fires five requests at once must not start five rotations, which
   * would look exactly like token theft to the server.
   */
  async refreshOnce(): Promise<boolean> {
    this.refreshing ??= this.performRefresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async performRefresh(): Promise<boolean> {
    try {
      const result = await this.request<{ tokens: { accessToken: string } }>('/auth/refresh', {
        method: 'POST',
        skipRefresh: true,
      })
      this.accessToken = result.tokens.accessToken
      return true
    } catch {
      this.accessToken = null
      return false
    }
  }

  private async send(path: string, options: RequestOptions): Promise<Response> {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (options.body !== undefined) headers['content-type'] = 'application/json'
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`

    const deviceId = this.options.deviceId?.()
    if (deviceId) headers['x-clinote-device'] = deviceId

    const workspaceId = this.options.workspaceId?.()
    if (workspaceId) headers['x-clinote-workspace'] = workspaceId

    try {
      return await fetch(`${this.options.baseUrl}${path}`, {
        method: options.method ?? 'GET',
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        // Required for the refresh cookie to travel.
        credentials: 'include',
        signal: options.signal,
      })
    } catch (cause) {
      throw new AppError('network_unavailable', {
        message: 'Clinote could not reach the server. Your local data is unaffected.',
        cause,
      })
    }
  }

  private async parse<T>(response: Response): Promise<T> {
    if (response.status === 204) return undefined as T

    const text = await response.text()
    const payload = text ? safeJson(text) : null

    if (!response.ok) {
      const error = (payload as { error?: { code?: string; message?: string; details?: unknown } })
        ?.error
      throw new AppError(asErrorCode(error?.code, response.status), {
        message: error?.message ?? 'Something went wrong. Please try again.',
        details: (error?.details as Record<string, unknown>) ?? {},
      })
    }

    return payload as T
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * The shared taxonomy, not a copy of it.
 *
 * A hand-maintained list drops codes the server has and the client has not
 * heard of yet — which is how `key_unavailable` once arrived as `not_found`
 * and left a screen waiting forever.
 */
const KNOWN_CODES = new Set<string>(ERROR_CODES)

/** An unrecognised code from a newer server must still map to something sane. */
function asErrorCode(code: string | undefined, status: number): ErrorCode {
  if (code && KNOWN_CODES.has(code)) return code as ErrorCode
  if (status === 401) return 'unauthenticated'
  if (status === 403) return 'forbidden'
  if (status === 404) return 'not_found'
  if (status === 422) return 'validation_failed'
  if (status === 429) return 'rate_limited'
  return 'internal'
}
