/**
 * The passphrase that protects everything leaving this device.
 *
 * "Locked" is a normal state, not an error: a device that cannot unlock still
 * works completely on its own data — it simply does not sync
 * (docs/encryption.md §5).
 */
import { AppError, nowIso } from '@clinote/shared'
import { withPersonalCore } from '~/database'
import { DataKeyCipher, keyIdFor } from '~/services/encryption'
import {
  createIdentity,
  createKeyMaterial,
  openIdentity,
  rotatePassphrase,
  unlockKeyMaterial,
  unlockWithRecoveryKey,
  type EnvelopeCipher,
  type StoredIdentity,
  type StoredKeyMaterial,
} from '~/services/encryption'
import type { IdentityKeyPair } from '@clinote/crypto'

export type EncryptionState = 'unknown' | 'not_set_up' | 'locked' | 'unlocked'

/** Held in memory only, for the lifetime of the tab. */
let cipher: EnvelopeCipher | null = null
/**
 * The account data key: it encrypts sync payloads, wraps per-backup keys, and
 * is what gets re-wrapped when the passphrase changes.
 *
 * The passphrase-derived KEK is deliberately *not* kept. It is needed only
 * while deriving, wrapping or unwrapping, and holding it longer would keep a
 * direct product of the passphrase in memory for no benefit.
 */
let dataKey: CryptoKey | null = null
/**
 * This device's identity keypair, used only to receive and pass on workspace
 * keys (docs/encryption.md §9). Established lazily: an account that never joins
 * a workspace never needs one.
 */
let identity: IdentityKeyPair | null = null

export function useEncryption() {
  const state = useState<EncryptionState>('encryption.state', () => 'unknown')
  const busy = useState('encryption.busy', () => false)
  const errorMessage = useState<string | null>('encryption.error', () => null)
  /** Set once, right after setup or rotation, for the screen to show. */
  const recoveryKey = useState<string | null>('encryption.recoveryKey', () => null)

  async function refresh(): Promise<void> {
    if (cipher) {
      state.value = 'unlocked'
      return
    }
    try {
      const material = await useApi().request<StoredKeyMaterial>('/users/me/keys')
      // A reload should not demand the passphrase again on a device that has
      // already been unlocked once.
      state.value = (await restoreKeys(material)) ? 'unlocked' : 'locked'
    } catch (error) {
      state.value =
        error instanceof AppError && error.code === 'key_unavailable' ? 'not_set_up' : 'unknown'
    }
  }

  /**
   * The account key lives in the personal database, never in a workspace one.
   *
   * It belongs to the account rather than to a dataset: keeping it beside the
   * open workspace would mean a device "forgets" its passphrase the moment
   * somebody switches workspaces, and would put the same secret in as many
   * databases as the person has practices.
   */
  async function restoreKeys(material: StoredKeyMaterial): Promise<boolean> {
    try {
      const storedDek = await withPersonalCore((core) => core.db.cryptoKeys.get('dek'))
      if (!storedDek) return false

      cipher = new DataKeyCipher(storedDek.key, await keyIdFor(material))
      dataKey = storedDek.key
      return true
    } catch {
      return false
    }
  }

  async function rememberKeys(dek: CryptoKey): Promise<void> {
    try {
      await withPersonalCore((core) =>
        core.db.cryptoKeys.put({ id: 'dek', key: dek, storedAt: nowIso() }),
      )
    } catch {
      // Not being able to remember them only costs another passphrase prompt.
    }
  }

  async function forgetKeys(): Promise<void> {
    try {
      await withPersonalCore((core) => core.db.cryptoKeys.clear())
    } catch {
      // Nothing to do: the in-memory copy is already gone.
    }
  }

  async function setUp(passphrase: string): Promise<boolean> {
    return run(async () => {
      const created = await createKeyMaterial(passphrase)
      await useApi().request('/users/me/keys', { method: 'PUT', body: created.material })
      cipher = created.cipher
      dataKey = created.dek
      await rememberKeys(created.dek)
      // Shown once; the caller is responsible for making the user record it.
      recoveryKey.value = created.recoveryKey
      state.value = 'unlocked'
    })
  }

  async function unlock(passphrase: string): Promise<boolean> {
    return run(async () => {
      const material = await useApi().request<StoredKeyMaterial>('/users/me/keys')
      const unlocked = await unlockKeyMaterial(passphrase, material)
      cipher = unlocked.cipher
      dataKey = unlocked.dek
      await rememberKeys(unlocked.dek)
      state.value = 'unlocked'
    })
  }

  /** Signing out, or locking deliberately, forgets the keys on this device. */
  async function unlockWithRecovery(recovery: string): Promise<boolean> {
    return run(async () => {
      const material = await useApi().request<StoredKeyMaterial>('/users/me/keys')
      const unlocked = await unlockWithRecoveryKey(recovery, material)
      cipher = unlocked.cipher
      dataKey = unlocked.dek
      await rememberKeys(unlocked.dek)
      state.value = 'unlocked'
    })
  }

  /**
   * Changes the passphrase and issues a new recovery key.
   *
   * Requires an unlocked device: without the data key there is nothing to
   * re-wrap, and no way to prove the old passphrase was known.
   */
  async function changePassphrase(newPassphrase: string): Promise<boolean> {
    return run(async () => {
      if (!dataKey) {
        throw new AppError('key_unavailable', {
          message: 'Unlock this device before changing the passphrase.',
        })
      }

      const rotated = await rotatePassphrase(dataKey, newPassphrase)
      await useApi().request('/users/me/keys/rotate', { method: 'POST', body: rotated.material })
      recoveryKey.value = rotated.recoveryKey
    })
  }

  /**
   * Makes sure this account has an identity key, and that this device holds it.
   *
   * Publishing the public key is what makes it possible for a colleague to
   * seal a workspace key to this person. The private half never leaves here in
   * a readable form: the server only ever sees it wrapped with the account key.
   */
  async function ensureIdentity(): Promise<IdentityKeyPair | null> {
    if (identity) return identity
    if (!dataKey) return null

    const api = useApi()
    try {
      const stored = await api.request<StoredIdentity>('/users/me/identity')
      identity = await openIdentity(stored, dataKey)
      return identity
    } catch (error) {
      // Any failure other than "there is none yet" is not ours to paper over:
      // generating a second keypair would invalidate every workspace key
      // already sealed to the first one.
      if (!(error instanceof AppError) || error.code !== 'key_unavailable') return null
    }

    const created = await createIdentity(dataKey)
    await api.request('/users/me/identity', { method: 'PUT', body: created.stored })
    identity = created.identity
    return identity
  }

  async function lock(): Promise<void> {
    cipher = null
    dataKey = null
    identity = null
    await forgetKeys()
    state.value = 'locked'
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
    state,
    busy,
    errorMessage,
    recoveryKey,
    acknowledgeRecoveryKey: () => {
      recoveryKey.value = null
    },
    unlockWithRecovery,
    changePassphrase,
    isUnlocked: computed(() => state.value === 'unlocked'),
    cipher: () => cipher,
    /** Wraps per-backup keys; survives a passphrase change. */
    accountKey: () => dataKey,
    /** For sealing and opening workspace keys. Null until the account unlocks. */
    identity: () => identity,
    ensureIdentity,
    refresh,
    setUp,
    unlock,
    lock,
  }
}
