import { describe, expect, it } from 'vitest'
import { fromUtf8, utf8, type Bytes } from '@clinote/crypto'
import {
  createBackupCipher,
  createKeyMaterial,
  openBackupCipher,
  rotatePassphrase,
  unlockKeyMaterial,
  unlockWithRecoveryKey,
} from './encryption'

const PASSPHRASE = 'correct horse battery staple'

async function setup() {
  return createKeyMaterial(PASSPHRASE)
}

describe('setup', () => {
  it('issues a recovery key and wraps the data key twice', async () => {
    const { material, recoveryKey } = await setup()

    expect(recoveryKey).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{1,4})+$/)
    expect(material.wrappedDekSync).toBeDefined()
    expect(material.wrappedDekRecovery).not.toBeNull()
    // The two wrappings of the same key must not be the same bytes.
    expect(material.wrappedDekSync.key).not.toBe(material.wrappedDekRecovery?.key)
  })

  it('produces a key that reads what it wrote', async () => {
    const { cipher } = await setup()
    const sealed = await cipher.seal(utf8('clinical note'))
    expect(fromUtf8(await cipher.open(sealed))).toBe('clinical note')
  })
})

describe('unlocking', () => {
  it('opens with the passphrase on another device', async () => {
    const { material, cipher } = await setup()
    const sealed = await cipher.seal(utf8('from device A'))

    const elsewhere = await unlockKeyMaterial(PASSPHRASE, material)
    expect(fromUtf8(await elsewhere.cipher.open(sealed))).toBe('from device A')
  })

  it('opens with the recovery key when the passphrase is gone', async () => {
    const { material, cipher, recoveryKey } = await setup()
    const sealed = await cipher.seal(utf8('still readable'))

    const recovered = await unlockWithRecoveryKey(recoveryKey, material)
    expect(fromUtf8(await recovered.cipher.open(sealed))).toBe('still readable')
  })

  it('accepts a recovery key typed without its grouping', async () => {
    const { material, recoveryKey } = await setup()
    const typed = recoveryKey.replace(/-/g, '').toLowerCase()

    await expect(unlockWithRecoveryKey(typed, material)).resolves.toBeDefined()
  })

  it('refuses the wrong passphrase and the wrong recovery key', async () => {
    const { material } = await setup()
    const other = await setup()

    await expect(unlockKeyMaterial('not the passphrase', material)).rejects.toMatchObject({
      code: 'key_unavailable',
    })
    await expect(unlockWithRecoveryKey(other.recoveryKey, material)).rejects.toMatchObject({
      code: 'key_unavailable',
    })
  })

  it('says so plainly when there is no recovery key at all', async () => {
    const { material, recoveryKey } = await setup()
    const withoutRecovery = { ...material, wrappedDekRecovery: null }

    await expect(unlockWithRecoveryKey(recoveryKey, withoutRecovery)).rejects.toMatchObject({
      code: 'key_unavailable',
    })
  })
})

describe('changing the passphrase', () => {
  it('keeps everything written under the old one readable', async () => {
    const { material, cipher, dek } = await setup()
    const sealedBefore = await cipher.seal(utf8('written before the change'))

    const rotated = await rotatePassphrase(dek, 'a completely new passphrase')

    // The data key never changed — only its wrapping did.
    const afterChange = await unlockKeyMaterial('a completely new passphrase', rotated.material)
    expect(fromUtf8(await afterChange.cipher.open(sealedBefore))).toBe('written before the change')

    // ...and the old passphrase no longer opens the new wrapping.
    await expect(unlockKeyMaterial(PASSPHRASE, rotated.material)).rejects.toMatchObject({
      code: 'key_unavailable',
    })
    expect(material.salt).not.toBe(rotated.material.salt)
  })

  it('issues a fresh recovery key, and retires the old one', async () => {
    const { dek, recoveryKey } = await setup()
    const rotated = await rotatePassphrase(dek, 'a completely new passphrase')

    expect(rotated.recoveryKey).not.toBe(recoveryKey)
    await expect(
      unlockWithRecoveryKey(rotated.recoveryKey, rotated.material),
    ).resolves.toBeDefined()
    // The old key was printed against the old salt and must not still work.
    await expect(unlockWithRecoveryKey(recoveryKey, rotated.material)).rejects.toMatchObject({
      code: 'key_unavailable',
    })
  })
})

describe('per-backup keys', () => {
  it('opens a backup with the key that was wrapped for it', async () => {
    const { dek } = await setup()
    const { cipher, wrapped } = await createBackupCipher(dek)
    const sealed = await cipher.seal(utf8('archive bytes'))

    expect(fromUtf8(await (await openBackupCipher(dek, wrapped)).open(sealed))).toBe(
      'archive bytes',
    )
  })

  it('still opens after the passphrase changed', async () => {
    const { dek } = await setup()
    const backup = await createBackupCipher(dek)
    const sealed = await backup.cipher.seal(utf8('archive from before'))

    // Changing the passphrase re-wraps the account key; it does not replace it,
    // so backups taken before the change stay readable. Wrapping backup keys
    // with the passphrase-derived KEK instead would have stranded them.
    const rotated = await rotatePassphrase(dek, 'a completely new passphrase')
    const afterChange = await unlockKeyMaterial('a completely new passphrase', rotated.material)

    expect(
      fromUtf8(await (await openBackupCipher(afterChange.dek, backup.wrapped)).open(sealed)),
    ).toBe('archive from before')
  })

  it('is still reachable through the recovery key', async () => {
    const { dek, material, recoveryKey } = await setup()
    const backup = await createBackupCipher(dek)
    const sealed = await backup.cipher.seal(utf8('archive bytes'))

    const recovered = await unlockWithRecoveryKey(recoveryKey, material)
    expect(
      fromUtf8(await (await openBackupCipher(recovered.dek, backup.wrapped)).open(sealed)),
    ).toBe('archive bytes')
  })

  it('gives every backup its own key', async () => {
    const { dek } = await setup()
    const first = await createBackupCipher(dek)
    const second = await createBackupCipher(dek)

    expect(first.wrapped.key).not.toBe(second.wrapped.key)

    const sealed = (await first.cipher.seal(utf8('first archive'))) as Bytes
    await expect((await openBackupCipher(dek, second.wrapped)).open(sealed)).rejects.toBeDefined()
  })
})
