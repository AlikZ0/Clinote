/**
 * The shared API client instance.
 *
 * One client per app: it holds the in-memory access token and serialises token
 * rotation, and two instances would defeat both.
 */
import { ApiClient } from '~/api/client'
import { activeWorkspaceId, getLocalCore } from '~/database'

let instance: ApiClient | null = null
let deviceId: string | null = null

export function useApi(): ApiClient {
  instance ??= new ApiClient({
    baseUrl: useRuntimeConfig().public.apiBaseUrl as string,
    deviceId: () => deviceId,
    // Read on every request rather than captured: switching workspaces must
    // not leave a client pointing at the previous one.
    workspaceId: () => activeWorkspaceId(),
  })
  void resolveDeviceId()
  return instance
}

async function resolveDeviceId(): Promise<void> {
  if (deviceId) return
  try {
    deviceId = (await getLocalCore()).context.deviceId
  } catch {
    deviceId = null
  }
}
