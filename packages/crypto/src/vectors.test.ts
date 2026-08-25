/**
 * Known-answer tests (docs/encryption.md §9).
 *
 * These fixtures were produced once by this implementation and are now frozen.
 * If a change to the KDF, the wrapping or the envelope layout makes them fail,
 * that change would also have made every existing backup unreadable — which is
 * exactly the failure this file exists to make loud instead of silent.
 *
 * The iteration count is deliberately lower than production: what is pinned
 * here is the algorithm and the byte layout, not the cost parameter.
 */
import { describe, expect, it } from 'vitest'
import {
  decodeHeader,
  decryptEnvelope,
  deriveKek,
  deriveRecoveryKek,
  fromBase64,
  fromUtf8,
  toBase64,
  unwrapDataKey,
  type KdfParams,
} from './index'

const VECTOR = {
  passphrase: 'clinote test vector passphrase',
  recoveryKey: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG-HHHH-IIII-JJJJ-KKKK-LLLL-M',
  params: {
    kdf: 'pbkdf2-sha256',
    salt: 'BwcHBwcHBwcHBwcHBwcHBw==',
    iterations: 120_000,
  } satisfies KdfParams,
  keyId: 'CQkJCQkJCQkJCQkJCQkJCQ==',
  wrappedByPassphrase: {
    iv: 'EIAgmbjQyJF1WGU2',
    key: 'j5zAESg9SH1vZTBj9ZlbDqvnHYosNVy+cunkOEmPxZ0zYk7QAaK3Rlv060NdZLrg',
  },
  wrappedByRecoveryKey: {
    iv: 'nEFJ2sq1oDmSBbrh',
    key: 'quMdnBb+VAcfkeO1vX9ccJs5QsD0ytfJBdiNi0wzMGkstfXkCAkei7pf4HjGxX1c',
  },
  plaintext: 'the quick brown fox',
  envelope:
    'Q0xOVAEBCQkJCQkJCQkJCQkJCQkJCRz/Vz5rOyDXv0oe5PiYpzCAyyWWZ0xFWEw8W/5LXBsmkpU5f+HkbVEGBDGKz2yt',
} as const

describe('frozen vectors', () => {
  it('unwraps the data key with the passphrase and reads the envelope', async () => {
    const kek = await deriveKek(VECTOR.passphrase, VECTOR.params)
    const dek = await unwrapDataKey(VECTOR.wrappedByPassphrase, kek)

    const plaintext = await decryptEnvelope(fromBase64(VECTOR.envelope), dek)
    expect(fromUtf8(plaintext)).toBe(VECTOR.plaintext)
  })

  it('unwraps the same data key with the recovery key', async () => {
    const kek = await deriveRecoveryKek(VECTOR.recoveryKey, VECTOR.params)
    const dek = await unwrapDataKey(VECTOR.wrappedByRecoveryKey, kek)

    expect(fromUtf8(await decryptEnvelope(fromBase64(VECTOR.envelope), dek))).toBe(VECTOR.plaintext)
  })

  it('keeps the envelope layout it has always had', () => {
    const bytes = fromBase64(VECTOR.envelope)
    const header = decodeHeader(bytes)

    expect(fromUtf8(bytes.slice(0, 4))).toBe('CLNT')
    expect(header.version).toBe(1)
    expect(header.alg).toBe(1)
    expect(header.keyId).toBe(VECTOR.keyId)
    expect(toBase64(fromBase64(header.iv))).toBe(header.iv)
  })

  it('refuses the wrong passphrase against a frozen wrapping', async () => {
    const kek = await deriveKek('not the passphrase', VECTOR.params)
    await expect(unwrapDataKey(VECTOR.wrappedByPassphrase, kek)).rejects.toThrow()
  })
})
