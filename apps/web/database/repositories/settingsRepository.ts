/**
 * Device and application settings.
 *
 * IndexedDB, not localStorage: settings must survive and be evicted together
 * with the data they describe (docs/local-first.md §9).
 */
import { nowIso } from '@clinote/shared'
import { toAppError } from '@clinote/shared'
import type { ClinoteDatabase } from '../db'

export class SettingsRepository {
  constructor(private readonly db: ClinoteDatabase) {}

  async get<T>(key: string, fallback: T): Promise<T> {
    try {
      const row = await this.db.settings.get(key)
      return row === undefined ? fallback : (row.value as T)
    } catch (error) {
      throw toAppError(error)
    }
  }

  /**
   * Settings are device-local in Phase 2. Syncable preferences arrive in
   * Phase 9, when they get a stable id namespace of their own — the outbox
   * addresses entities by uuid, and a bare key is not one.
   */
  async set(key: string, value: unknown): Promise<void> {
    try {
      await this.db.settings.put({ key, value, updatedAt: nowIso() })
    } catch (error) {
      throw toAppError(error)
    }
  }

  async remove(key: string): Promise<void> {
    try {
      await this.db.settings.delete(key)
    } catch (error) {
      throw toAppError(error)
    }
  }

  async all(): Promise<Record<string, unknown>> {
    const rows = await this.db.settings.toArray()
    return Object.fromEntries(rows.map((row) => [row.key, row.value]))
  }
}
