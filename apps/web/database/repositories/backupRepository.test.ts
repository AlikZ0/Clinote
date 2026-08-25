import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LocalCore } from '../index'
import { createTestCore } from '../../test/factories'

let core: LocalCore

beforeEach(async () => {
  core = await createTestCore()
})

afterEach(() => {
  core.close()
})

function attempt(core: LocalCore) {
  return core.backups.start({
    kind: 'local_export',
    deviceId: core.context.deviceId,
    appVersion: '0.1.0',
  })
}

describe('BackupRepository', () => {
  it('records an attempt and completes it', async () => {
    const started = await attempt(core)
    expect(started.status).toBe('pending')

    await core.backups.complete(started.id, { sizeBytes: 2048, checksum: 'sha256:abc' })

    const latest = await core.backups.latestSuccessful()
    expect(latest).toMatchObject({ id: started.id, status: 'completed', sizeBytes: 2048 })
    expect(latest?.completedAt).not.toBeNull()
  })

  it('records a failure with its error code and no client data', async () => {
    const started = await attempt(core)
    await core.backups.fail(started.id, 'storage_quota_exceeded')

    const [row] = await core.backups.list()
    expect(row).toMatchObject({ status: 'failed', errorCode: 'storage_quota_exceeded' })
    expect(JSON.stringify(row)).not.toMatch(/notes|firstName|lastName/)
  })

  it('reports health and flags attention when the most recent attempt failed', async () => {
    const good = await attempt(core)
    await core.backups.complete(good.id, { sizeBytes: 10, checksum: 'sha256:a' })

    let health = await core.backups.health('2026-01-01T00:00:00.000Z')
    expect(health).toMatchObject({ successCount: 1, failureCount: 0, needsAttention: false })

    const bad = await attempt(core)
    await core.backups.fail(bad.id, 'network_unavailable')

    health = await core.backups.health('2026-01-01T00:00:00.000Z')
    expect(health).toMatchObject({ successCount: 1, failureCount: 1, needsAttention: true })
    expect(health.lastSuccessfulAt).not.toBeNull()
    expect(health.lastFailedAt).not.toBeNull()
  })

  it('needs attention when nothing has ever succeeded', async () => {
    expect((await core.backups.health('2026-01-01T00:00:00.000Z')).needsAttention).toBe(true)
  })

  it('counts only attempts inside the reporting window', async () => {
    const old = await attempt(core)
    await core.backups.complete(old.id, { sizeBytes: 1, checksum: 'sha256:a' })

    const health = await core.backups.health('2999-01-01T00:00:00.000Z')
    expect(health.successCount).toBe(0)
    expect(health.lastSuccessfulAt).not.toBeNull()
  })
})
