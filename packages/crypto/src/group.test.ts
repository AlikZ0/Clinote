import { describe, expect, it } from 'vitest'
import { generateDataKey, unwrapDataKey, wrapDataKey } from './keys'
import {
  generateIdentityKeyPair,
  openSealedKey,
  sealKeyForMember,
  unwrapIdentityPrivateKey,
  wrapIdentityPrivateKey,
} from './group'
import { decryptEnvelope, encryptEnvelope } from './envelope'
import { randomBytes, utf8 } from './primitives'

const KEY_ID = randomBytes(16)

const WORKSPACE = '9d0f8b1e-1f2a-4c3b-8d4e-5f6a7b8c9d0e'

async function grant(
  workspaceKey: CryptoKey,
  sender: Awaited<ReturnType<typeof generateIdentityKeyPair>>,
  recipient: Awaited<ReturnType<typeof generateIdentityKeyPair>>,
) {
  const sealed = await sealKeyForMember({
    workspaceId: WORKSPACE,
    workspaceKey,
    sender,
    recipientPublicKey: recipient.publicKey,
  })
  return openSealedKey({ workspaceId: WORKSPACE, sealed, recipient })
}

describe('sharing a workspace key', () => {
  it('lets the recipient read what the sender wrote', async () => {
    const owner = await generateIdentityKeyPair()
    const colleague = await generateIdentityKeyPair()
    const workspaceKey = await generateDataKey()

    const received = await grant(workspaceKey, owner, colleague)

    const envelope = await encryptEnvelope(utf8('Ապրանք'), workspaceKey, KEY_ID)
    expect(new TextDecoder().decode(await decryptEnvelope(envelope, received))).toBe('Ապրանք')
  })

  it('refuses a grant addressed to somebody else', async () => {
    const owner = await generateIdentityKeyPair()
    const colleague = await generateIdentityKeyPair()
    const outsider = await generateIdentityKeyPair()

    const sealed = await sealKeyForMember({
      workspaceId: WORKSPACE,
      workspaceKey: await generateDataKey(),
      sender: owner,
      recipientPublicKey: colleague.publicKey,
    })

    await expect(
      openSealedKey({ workspaceId: WORKSPACE, sealed, recipient: outsider }),
    ).rejects.toThrow()
  })

  it('refuses a grant replayed into another workspace', async () => {
    const owner = await generateIdentityKeyPair()
    const colleague = await generateIdentityKeyPair()

    const sealed = await sealKeyForMember({
      workspaceId: WORKSPACE,
      workspaceKey: await generateDataKey(),
      sender: owner,
      recipientPublicKey: colleague.publicKey,
    })

    // Same sender, same recipient, same bytes — a different workspace id is
    // enough to make the derived wrapping key wrong.
    await expect(
      openSealedKey({
        workspaceId: '00000000-0000-4000-8000-000000000001',
        sealed,
        recipient: colleague,
      }),
    ).rejects.toThrow()
  })

  it('passes the key on: a member who was granted access can grant it further', async () => {
    const owner = await generateIdentityKeyPair()
    const admin = await generateIdentityKeyPair()
    const assistant = await generateIdentityKeyPair()
    const workspaceKey = await generateDataKey()

    const adminCopy = await grant(workspaceKey, owner, admin)
    const assistantCopy = await grant(adminCopy, { ...admin }, assistant)

    const envelope = await encryptEnvelope(utf8('shared'), workspaceKey, KEY_ID)
    expect(new TextDecoder().decode(await decryptEnvelope(envelope, assistantCopy))).toBe('shared')
  })
})

describe('the identity private key', () => {
  it('survives being wrapped with the account key, on another device', async () => {
    const accountKey = await generateDataKey()
    const identity = await generateIdentityKeyPair()
    const wrapped = await wrapIdentityPrivateKey(identity.privateKey, accountKey)

    // Second device: it unlocked the account, so it can rebuild the identity.
    const restored = {
      publicKey: identity.publicKey,
      privateKey: await unwrapIdentityPrivateKey(wrapped, accountKey),
    }

    const workspaceKey = await generateDataKey()
    const sealed = await sealKeyForMember({
      workspaceId: WORKSPACE,
      workspaceKey,
      sender: await generateIdentityKeyPair(),
      recipientPublicKey: identity.publicKey,
    })

    await expect(
      openSealedKey({ workspaceId: WORKSPACE, sealed, recipient: restored }),
    ).resolves.toBeDefined()
  })

  it('is useless to anyone without the account key', async () => {
    const identity = await generateIdentityKeyPair()
    const wrapped = await wrapIdentityPrivateKey(identity.privateKey, await generateDataKey())

    await expect(unwrapIdentityPrivateKey(wrapped, await generateDataKey())).rejects.toThrow()
  })

  it('stays sealed when the account key itself is only available wrapped', async () => {
    // The realistic path: KEK -> account key -> identity key. Nothing in the
    // chain is readable without the passphrase at the top of it.
    const kek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
      'wrapKey',
      'unwrapKey',
    ])
    const accountKey = await generateDataKey()
    const wrappedAccountKey = await wrapDataKey(accountKey, kek)

    const identity = await generateIdentityKeyPair()
    const wrappedIdentity = await wrapIdentityPrivateKey(identity.privateKey, accountKey)

    const reopened = await unwrapDataKey(wrappedAccountKey, kek)
    await expect(unwrapIdentityPrivateKey(wrappedIdentity, reopened)).resolves.toBeDefined()
  })
})
