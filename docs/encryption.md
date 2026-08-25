# Encryption

> We do not invent cryptography (§85, I8). Every primitive below is a standard
> Web Crypto algorithm used in its intended mode.

## 1. Threat model in one line

The Clinote backend, its database, its object storage and anyone who obtains a
dump of them must be unable to read client data.

Out of scope: a compromised end-user device, a malicious browser extension, and
an attacker who has the user's passphrase.

## 2. Primitives

| Purpose                        | Algorithm                | Parameters                                 |
| ------------------------------ | ------------------------ | ------------------------------------------ |
| Key derivation from passphrase | PBKDF2-HMAC-SHA-256      | ≥ 600,000 iterations, 16-byte random salt  |
| Content encryption             | AES-256-GCM              | 12-byte random IV per message, 16-byte tag |
| Key wrapping                   | AES-256-GCM              | wraps the DEK with the KEK                 |
| Integrity                      | SHA-256                  | archive and per-file digests               |
| Randomness                     | `crypto.getRandomValues` | never `Math.random`                        |

PBKDF2 is chosen because it is available in Web Crypto everywhere Clinote runs.
Argon2id is preferred cryptographically but requires WASM; the KDF identifier is
stored in the key metadata so it can be migrated without breaking old backups.

## 3. Key hierarchy

```
passphrase ──PBKDF2(salt, iters)──▶ KEK  ──wraps──▶ DEK_account
recovery key (32 bytes, shown once) ──HKDF──▶ KEK' ──wraps──▶ DEK_account
                                                        │
                                                        └─ wraps ─▶ DEK_backup
                                                                    (one per backup)
```

**Per-backup keys are wrapped with the account data key, not with the KEK.**
Phase 11 changed this after a test showed the consequence of the original
design: the KEK is re-derived whenever the passphrase changes, so every backup
taken before a change became unopenable — precisely when a person is most likely
to need one. `DEK_account` never changes; only its wrapping does. The failing
test is `encryption.test.ts › still opens after the passphrase changed`.

For the same reason `unwrapDataKey` grants the unwrapped key the _same_ usages
the original had, including `unwrapKey`: an account key that came back through
an unwrap on a second device must be able to open the backups the first device
made.

The passphrase-derived KEK is never kept after the operation that needed it.

The server stores only: `salt`, `kdf`, `iterations`, and the **wrapped** DEKs. It
can never unwrap them.

## 4. Envelope format

Every encrypted artifact (backup archive, sync envelope, blob part) uses the same
self-describing header so that formats can evolve:

```
magic "CLNT"          4 bytes
version               1 byte
alg id                1 byte   (1 = AES-256-GCM)
key id                16 bytes (which DEK)
iv                    12 bytes
ciphertext + tag      rest
```

Decryption fails closed: an unknown version, unknown alg or a tag mismatch is a
hard error, never a fallback to plaintext.

## 5. Device enrollment (R4)

Device B needs `DEK_sync` without the server learning it.

```
Device B: login (email + password)     → session, but no data keys
Device B: prompt "Encryption passphrase" (or recovery key)
Device B: GET /keys/wrapped            → { salt, kdf, iterations, wrappedDekSync }
Device B: derive KEK, unwrap DEK_sync locally
Device B: register device, start sync
```

The account password and the encryption passphrase are **different secrets** by
default. A user may opt to reuse the account password; the UI explains that this
weakens the zero-knowledge property against a malicious server that could serve
modified frontend code, and the default is a separate passphrase.

## 6. Recovery key (R3)

At encryption setup the user is shown a 32-byte recovery key (base32, grouped),
must confirm they stored it, and is told plainly:

> Clinote cannot recover your backups without your passphrase or recovery key.
> We do not have a copy.

Both wrappers protect the same account key, so either secret restores access.
Entry is forgiving — dashes and letter case are ignored — because it will be
typed from paper, by someone already having a bad day.

HKDF rather than PBKDF2 for this one: a recovery key is 256 bits of
machine-generated entropy, so there is no weak secret to slow an attacker down
against, and stretching it would only cost the user time.

A recovery key unlocks; it does not reveal or reset the passphrase, because
nothing stores one. Choosing a new passphrase afterwards is §7.

## 7. Rotation

- Changing the passphrase re-derives the KEK and re-wraps the DEKs. Existing
  backups stay readable because the DEKs themselves are unchanged.
- Compromise of a DEK requires re-encrypting affected artifacts; the key id in
  the envelope header makes it possible to identify them.

## 8. What is NOT encrypted

Deliberately, because functionality requires it — and each item is minimized:

| Item                                                                                         | Why                              | Contains                                                  |
| -------------------------------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------- |
| Backup size, checksum, timestamp, device id                                                  | verification, quotas, history UI | no client data                                            |
| Sync envelope routing metadata: account/workspace id, entity **type**, opaque entity id, HLC | ordering and fan-out             | no names, no notes                                        |
| Appointment reminder schedule rows                                                           | server-side scheduling (§76)     | `startAt`, offset, user id — no client identity, no title |

See `notifications.md` §"Minimum disclosure" for the reasoning about the last row.

## 9. Sharing one dataset with several people (§41, Phase 14)

A workspace has **one data key**, and every member's device needs it. The
server must never have it. So the key travels device to device.

```
member A device                              member B device
  workspace key ──seal──▶ [server relays] ──▶ open──▶ workspace key
        │                  (opaque blob)                   │
   ECDH private            cannot open              ECDH private
```

Each account has a long-lived **identity keypair** (ECDH P-256):

- the public half is published through the server, so colleagues can seal to it;
- the private half is wrapped with the account data key. That is what lets the
  same person open the workspace on a second device by unlocking their account,
  and nobody else open it at all.

Sealing is standard WebCrypto and nothing more: ECDH to agree on a secret,
HKDF to turn it into a wrapping key, AES-GCM to wrap. The HKDF `info` binds the
workspace id and _both_ public keys, so a grant cannot be replayed towards a
different person or a different workspace — the derivation simply produces a
different key and the unwrap fails. There are tests for both.

### Consequences, stated plainly

- **Joining a workspace is not access to its data.** A new member is a member
  immediately and can read nothing until somebody who holds the key grants it.
  The UI says so rather than showing an empty screen.
- **A grant requires a device that holds the key.** There is no server-side
  path, by design. If every key-holder is unreachable, a new member waits.
- **The identity public key cannot be silently replaced.** Doing so would
  invalidate every workspace key already sealed to it, so the server refuses;
  rotation is a deliberate re-grant-everything operation.
- **Removing a member deletes their sealed copy.** That ends future access. It
  does not un-tell them what they already read — no system can, and claiming
  otherwise would be a lie told to a clinic about its own data.
- **Where each key lives.** The account key belongs to the account and is kept
  in the _personal_ database; the workspace key belongs to the dataset and is
  kept in that workspace's database. Keeping the account key beside the open
  workspace would make a device "forget" its passphrase whenever somebody
  switched workspaces.

## 10. Implementation rules

- All crypto lives in `packages/crypto`. Application code calls
  `encryptEnvelope` / `decryptEnvelope`, never `subtle.encrypt` directly.
- Keys are non-extractable `CryptoKey` objects wherever the flow allows it.
- Key material is never written to `localStorage`, never logged, never included
  in error reports, and is held in memory (or a non-extractable IndexedDB
  `CryptoKey`) for the session.
- Test vectors are committed: known passphrase + salt → known KEK; known DEK +
  IV + plaintext → known ciphertext. Regressions in the KDF or envelope layout
  would otherwise silently make old backups unreadable.
