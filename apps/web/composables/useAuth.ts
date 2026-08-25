/**
 * Account session (docs/security.md §3, product spec §36).
 *
 * Signing in is optional: Clinote Free works fully without an account, so
 * every failure here degrades to "not signed in" rather than blocking the app.
 */
import { AppError } from '@clinote/shared'
import type { AuthResponse, MeResponse, RegisterDeviceRequest, User } from '@clinote/types'
import { getLocalCore } from '~/database'
import { detectPlatform } from '~/utils/platform'

export type AuthStatus = 'unknown' | 'anonymous' | 'authenticated'

export function useAuth() {
  const user = useState<User | null>('auth.user', () => null)
  const status = useState<AuthStatus>('auth.status', () => 'unknown')
  const errorMessage = useState<string | null>('auth.error', () => null)
  const busy = useState('auth.busy', () => false)
  const { setEntitlement } = useFeatureAccess()
  const api = useApi

  async function deviceId(): Promise<string | null> {
    try {
      return (await getLocalCore()).context.deviceId
    } catch {
      return null
    }
  }

  function adopt(response: AuthResponse): void {
    api().setAccessToken(response.tokens.accessToken)
    user.value = response.user
    status.value = 'authenticated'
    setEntitlement(response.entitlement)
  }

  /**
   * Restores a session from the refresh cookie on app start. Silent by design:
   * "not signed in" is a normal state, not an error to report.
   */
  async function restore(): Promise<void> {
    await deviceId()
    try {
      if (!(await api().refreshOnce())) {
        status.value = 'anonymous'
        return
      }
      const me = await api().request<MeResponse>('/users/me')
      user.value = me.user
      status.value = 'authenticated'
      setEntitlement(me.entitlement)
      void registerDevice()
    } catch {
      status.value = 'anonymous'
    }
  }

  async function register(input: {
    email: string
    password: string
    name?: string
  }): Promise<boolean> {
    return run(async () => {
      adopt(await api().request<AuthResponse>('/auth/register', { method: 'POST', body: input }))
      void registerDevice()
    })
  }

  async function login(input: { email: string; password: string }): Promise<boolean> {
    return run(async () => {
      adopt(await api().request<AuthResponse>('/auth/login', { method: 'POST', body: input }))
      void registerDevice()
    })
  }

  async function logout(): Promise<void> {
    try {
      await api().request('/auth/logout', { method: 'POST' })
    } catch {
      // Ending the local session matters more than the server's answer.
    }
    api().setAccessToken(null)
    await useEncryption().lock()
    user.value = null
    status.value = 'anonymous'
    // Back to Free: the account is what granted anything beyond it.
    setEntitlement({
      planId: 'free',
      status: 'active',
      features: {},
      limits: {},
      usage: { storageBytes: 0, devices: 0, members: 0 },
      expiresAt: null,
    })
  }

  async function requestPasswordReset(email: string): Promise<boolean> {
    return run(async () => {
      await api().request('/auth/forgot-password', { method: 'POST', body: { email } })
    })
  }

  async function resetPassword(token: string, password: string): Promise<boolean> {
    return run(async () => {
      await api().request('/auth/reset-password', { method: 'POST', body: { token, password } })
    })
  }

  /**
   * Registers this device so sync can attribute its envelopes.
   *
   * A refusal is expected on Free — multi-device is a paid capability — and is
   * not surfaced as an error.
   */
  async function registerDevice(): Promise<void> {
    const id = await deviceId()
    if (!id || status.value !== 'authenticated') return

    const platform = detectPlatform(navigator.userAgent, navigator.maxTouchPoints)
    const body: RegisterDeviceRequest = {
      id,
      name: defaultDeviceName(platform),
      platform,
    }

    try {
      await api().request('/devices', { method: 'POST', body })
    } catch (error) {
      if (error instanceof AppError && error.code === 'device_limit_reached') return
      if (error instanceof AppError && error.code === 'network_unavailable') return
      throw error
    }
  }

  async function run(operation: () => Promise<void>): Promise<boolean> {
    busy.value = true
    errorMessage.value = null
    try {
      await operation()
      return true
    } catch (error) {
      errorMessage.value = describeError(error)
      return false
    } finally {
      busy.value = false
    }
  }

  return {
    user,
    status,
    busy,
    errorMessage,
    isAuthenticated: computed(() => status.value === 'authenticated'),
    restore,
    register,
    login,
    logout,
    requestPasswordReset,
    resetPassword,
    registerDevice,
  }
}

function defaultDeviceName(platform: string): string {
  switch (platform) {
    case 'ios':
      return 'iPhone or iPad'
    case 'android':
      return 'Android device'
    case 'desktop':
      return 'This computer'
    default:
      return 'This device'
  }
}
