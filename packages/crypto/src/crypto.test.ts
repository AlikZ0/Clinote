import { describe, expect, it } from 'vitest'
import {
  ALG_AES_256_GCM,
  HEADER_BYTES,
  createKdfParams,
  decodeHeader,
  decryptEnvelope,
  deriveKek,
  deriveRecoveryKek,
  encryptEnvelope,
  fromBase64,
  generateDataKey,
  generateRecoveryKey,
  normalizeRecoveryKey,
  randomBytes,
  sha256Hex,
  timingSafeEqual,
  toBase64,
  unwrapDataKey,
  utf8,
  wrapDataKey,
} from './index'

// Fewer iterations in tests: 600k would make the suite unusable. Production
// parameters are asserted separately below.
const TEST_KDF = { ...createKdfParams(120_000) }

/** Flips one bit so the tampering tests do not depend on index assertions. */
function flipByte(bytes: Uint8Array, index: number): void {
  bytes.set([(bytes.at(index) ?? 0) ^ 0xff], index)
}

describe('primitives', () => {
  it('produces the known SHA-256 vector for "abc"', async () => {
    expect(await sha256Hex(utf8('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
  })

  it('round-trips base64 for arbitrary bytes', () => {
    const bytes = randomBytes(257)
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes))
  })

  it('compares in constant time without leaking on length', () => {
    expect(timingSafeEqual(utf8('same'), utf8('same'))).toBe(true)
    expect(timingSafeEqual(utf8('same'), utf8('diff'))).toBe(false)
    expect(timingSafeEqual(utf8('same'), utf8('longer'))).toBe(false)
  })
})

describe('envelope encryption', () => {
  it('round-trips a payload', async () => {
    const key = await generateDataKey()
    const keyId = randomBytes(16)
    const plaintext = utf8(JSON.stringify({ clientId: 'x', notes: 'sensitive' }))

    const envelope = await encryptEnvelope(plaintext, key, keyId)
    expect(Array.from(await decryptEnvelope(envelope, key))).toEqual(Array.from(plaintext))
  })

  it('writes a self-describing header and never leaks plaintext into it', async () => {
    const key = await generateDataKey()
    const keyId = randomBytes(16)
    const envelope = await encryptEnvelope(utf8('Ivan Petrov'), key, keyId)

    const header = decodeHeader(envelope)
    expect(header.version).toBe(1)
    expect(header.alg).toBe(ALG_AES_256_GCM)
    expect(header.keyId).toBe(toBase64(keyId))
    expect(new TextDecoder().decode(envelope)).not.toContain('Ivan')
  })

  it('fails closed when the ciphertext is tampered with', async () => {
    const key = await generateDataKey()
    const envelope = await encryptEnvelope(utf8('payload'), key, randomBytes(16))
    flipByte(envelope, envelope.length - 1)
    await expect(decryptEnvelope(envelope, key)).rejects.toThrow()
  })

  it('fails closed when the authenticated header is tampered with', async () => {
    const key = await generateDataKey()
    const envelope = await encryptEnvelope(utf8('payload'), key, randomBytes(16))
    flipByte(envelope, 10) // inside keyId, which is authenticated additional data
    await expect(decryptEnvelope(envelope, key)).rejects.toThrow()
  })

  it('rejects an unknown envelope version instead of guessing', async () => {
    const key = await generateDataKey()
    const envelope = await encryptEnvelope(utf8('payload'), key, randomBytes(16))
    envelope.set([99], 4)
    expect(() => decodeHeader(envelope)).toThrow(/version/i)
  })

  it('rejects foreign data', () => {
    expect(() => decodeHeader(new Uint8Array(HEADER_BYTES))).toThrow(/Clinote envelope/)
    expect(() => decodeHeader(new Uint8Array(4))).toThrow(/truncated/i)
  })

  it('cannot be opened with a different key', async () => {
    const envelope = await encryptEnvelope(
      utf8('payload'),
      await generateDataKey(),
      randomBytes(16),
    )
    await expect(decryptEnvelope(envelope, await generateDataKey())).rejects.toThrow()
  })
})

describe('key hierarchy', () => {
  it('wraps and unwraps a data key with a passphrase-derived KEK', async () => {
    const kek = await deriveKek('correct horse battery staple', TEST_KDF)
    const dek = await generateDataKey()
    const keyId = randomBytes(16)
    const envelope = await encryptEnvelope(utf8('backup'), dek, keyId)

    const wrapped = await wrapDataKey(dek, kek)
    const restored = await unwrapDataKey(
      wrapped,
      await deriveKek('correct horse battery staple', TEST_KDF),
    )

    expect(Array.from(await decryptEnvelope(envelope, restored))).toEqual(
      Array.from(utf8('backup')),
    )
  })

  it('refuses to unwrap with the wrong passphrase', async () => {
    const kek = await deriveKek('right', TEST_KDF)
    const wrapped = await wrapDataKey(await generateDataKey(), kek)
    await expect(unwrapDataKey(wrapped, await deriveKek('wrong', TEST_KDF))).rejects.toThrow()
  })

  it('defaults to production-grade KDF parameters', () => {
    const params = createKdfParams()
    expect(params.kdf).toBe('pbkdf2-sha256')
    expect(params.iterations).toBeGreaterThanOrEqual(600_000)
    expect(fromBase64(params.salt).length).toBe(16)
  })

  it('refuses a dangerously weak iteration count', async () => {
    await expect(deriveKek('pass', { ...TEST_KDF, iterations: 1_000 })).rejects.toThrow(
      /iterations/i,
    )
  })

  it('generates a transcribable recovery key', () => {
    const key = generateRecoveryKey()
    expect(key).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{1,4})+$/)
    expect(normalizeRecoveryKey(key.toLowerCase())).toBe(key.replace(/-/g, ''))
    expect(generateRecoveryKey()).not.toBe(key)
    // 32 bytes of entropy, base32: enough that guessing is not a strategy.
    expect(normalizeRecoveryKey(key).length).toBeGreaterThanOrEqual(51)
  })

  it('opens the same data key with either secret', async () => {
    const params = { ...TEST_KDF }
    const recoveryKey = generateRecoveryKey()

    const dek = await generateDataKey()
    const keyId = randomBytes(16)
    const envelope = await encryptEnvelope(utf8('sensitive'), dek, keyId)

    const byPassphrase = await wrapDataKey(dek, await deriveKek('the passphrase', params))
    const byRecovery = await wrapDataKey(dek, await deriveRecoveryKek(recoveryKey, params))

    // Either wrapper unwraps the same key, so a lost passphrase is survivable.
    for (const [wrapped, kek] of [
      [byPassphrase, await deriveKek('the passphrase', params)],
      [byRecovery, await deriveRecoveryKek(recoveryKey, params)],
    ] as const) {
      const restored = await unwrapDataKey(wrapped, kek)
      expect(Array.from(await decryptEnvelope(envelope, restored))).toEqual(
        Array.from(utf8('sensitive')),
      )
    }
  })

  it('refuses a recovery key that is not the right one', async () => {
    const params = { ...TEST_KDF }
    const wrapped = await wrapDataKey(
      await generateDataKey(),
      await deriveRecoveryKek(generateRecoveryKey(), params),
    )

    await expect(
      unwrapDataKey(wrapped, await deriveRecoveryKek(generateRecoveryKey(), params)),
    ).rejects.toThrow()
  })

  it('refuses a recovery key too short to be one', async () => {
    await expect(deriveRecoveryKek('ABCD-EFGH', { ...TEST_KDF })).rejects.toThrow(/too short/i)
  })
})
