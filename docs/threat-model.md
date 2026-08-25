# Threat model

Written for Phase 15, against the system as it is built — not against a generic
web application. Every entry names what an attacker gets if they succeed, what
stands in their way today, and where that is tested. Where nothing stands in
their way, it says so.

## 1. What is worth attacking

| Asset                | Where it lives                     | Worst case if lost                       |
| -------------------- | ---------------------------------- | ---------------------------------------- |
| Client records       | IndexedDB on the device            | A clinic's patient list, in the clear    |
| Encrypted envelopes  | PostgreSQL, S3                     | Ciphertext, plus who wrote what and when |
| Account passphrase   | Nowhere — derived in memory        | Everything above, permanently            |
| Account data key     | IndexedDB (non-extractable handle) | Everything that account can read         |
| Workspace key        | Member devices                     | One practice's shared records            |
| Identity private key | IndexedDB, wrapped                 | The ability to be handed workspace keys  |
| Refresh token        | HttpOnly cookie                    | A session, until it is used twice        |
| Audit log            | PostgreSQL                         | Who worked when — no record contents     |

The passphrase is the root of the tree and is never stored, transmitted or
recoverable. That is the design's central bet: it makes some support requests
impossible to satisfy, and it is what lets the rest of this document be short.

## 2. Trust boundaries

```
device (trusted)  │  transport (hostile)  │  server (semi-trusted)  │  storage/mail (untrusted)
   plaintext      │      TLS only         │      ciphertext only    │     ciphertext only
```

**The server is semi-trusted, not trusted.** It routes, orders, bills and
enforces entitlements. It cannot read a record, and no endpoint exists that
would let it try. An operator with full database access sees encrypted blobs,
timing, sizes and account metadata.

## 3. Threats

### T1 — Server operator or database breach reads client data

_Mitigated._ AES-256-GCM client-side; the server holds wrapped keys it cannot
unwrap (`docs/encryption.md` §3). Verified by `apps/api/src/sync/sync.test.ts`
(the relay never inspects a payload) and by the backup artifact test, which
asserts a known client name does not appear in the uploaded bytes.

_Residual:_ metadata. Row counts, envelope sizes, timing and device counts are
visible. A clinic with one client is distinguishable from one with a thousand.
Accepted; hiding it would mean padding and cover traffic.

### T2 — Stolen device

_Partially mitigated._ Local data is readable by whoever holds an unlocked
device — the same as a paper file drawer left open, and the price of working
offline. The account data key is stored as a non-extractable `CryptoKey`, so it
cannot be copied out even by script on the page; "lock this device" removes it.

_Not mitigated:_ there is no app-level PIN and no remote wipe. Full-disk
encryption and the device lock screen are the control. Stated here rather than
implied, because a clinic should decide with the true picture.

### T3 — Stolen refresh token

_Mitigated._ HttpOnly, `SameSite=Strict`, path-scoped, rotated on every use,
with family-level reuse detection: the second use of a token kills every
session in its chain (`apps/api/src/security/access.test.ts`).

### T4 — Token forgery

_Mitigated._ HS256 with a pinned algorithm list, issuer and audience checks. An
`alg: none` token, a token signed with another secret, a token minted for a
different audience and an expired token are each rejected, and each has a test.

### T5 — Reaching another account's data by id

_Mitigated._ Every owned resource is looked up by id _and_ owner, and answers
`404` rather than `403` so that existence is not disclosed. Backups, devices,
keys, envelopes and workspaces each have a test that tries it as another
account.

### T6 — A workspace member exceeding their role

_Mitigated server-side._ Permissions are checked on the server for every
workspace route; a Viewer's push is refused even though the UI never offers it
(`apps/api/src/workspaces/teamsync.test.ts`). An admin cannot change the
owner's role or remove the owner.

_Residual:_ a member who has been granted the workspace key keeps what they
have already read. Removing them ends future access and cannot undo the past.

### T7 — XSS in the app

_Mitigated by construction and by policy._ No `v-html`, no `innerHTML`, no
`eval`; Vue escapes interpolation. CSP with `script-src 'self'` plus per-build
hashes for the one inline script Nuxt emits — no `'unsafe-inline'`
(`apps/web/build/csp.test.ts`, and the policy is asserted in the built page).

### T8 — CSRF

_Mitigated._ The refresh cookie is `SameSite=Strict` and path-scoped; every
other authenticated call carries a bearer token in a header, which a
cross-origin form cannot set. CORS names one origin and does not reflect the
request's.

### T9 — Cached or logged disclosure

_Mitigated._ Every response except the public plan catalogue and the health
probes is `no-store`, because responses carry wrapped keys, sealed workspace
keys and presigned URLs. Logs are redacted, and
`apps/api/src/security/redaction.test.ts` runs the real flows and then searches
everything the process logged for the secrets that went in.

### T10 — Supply chain

_Partially mitigated._ `pnpm audit` runs in CI at `--audit-level high` for
production dependencies; the lockfile is committed and CI installs with
`--frozen-lockfile`. Dependencies are few and deliberately boring, and the API
adds no header middleware it could have inherited.

_Residual:_ a compromised transitive dependency executes inside the bundle,
where CSP cannot help — `'self'` covers it. `connect-src` limits where it could
send anything, which is the one meaningful brake.

### T11 — Denial of service

_Partially mitigated._ Global and per-route rate limits, a 1 MB JSON body
limit, per-envelope size limits, and storage quotas per plan. Nothing here
stands up to a determined distributed attack; that belongs to the edge.

### T12 — Malicious or forged webhook

_Mitigated._ HMAC over the exact received bytes, compared in constant time,
with idempotency on `(provider, external_id)`. A forged signature is `403`, a
replay changes nothing (`apps/api/src/billing/billing.test.ts`).

### T13 — Account enumeration

_Partially mitigated._ Password reset and sign-in give identical answers for a
known and an unknown address, and both are tested. Registration necessarily
says an address is taken — the accepted cost of not gating sign-up behind email
verification.

### T14 — Forged client address

_Mitigated._ `X-Forwarded-For` is honoured only for as many hops as
`TRUST_PROXY` declares, and ignored entirely by default. Otherwise a client
could pick its own rate-limit bucket and its own line in a clinic's audit log.

### T15 — Backup or restore tampering

_Mitigated._ Ciphertext is digest-verified server-side on completion; a restore
decrypts and validates before touching the local database, and never destroys
the current data first (invariant I5).

## 4. What we have decided not to defend against

Stated plainly so nobody has to guess:

- **A compromised device.** Malware with access to an unlocked browser profile
  can read what the user can read.
- **A hostile operator changing the code.** Anyone who can deploy the bundle can
  ship one that leaks keys. Local-first reduces the blast radius; it does not
  remove this.
- **Traffic analysis.** Sizes and timings are visible to anyone who can watch
  the connection metadata.
- **A lost passphrase with a lost recovery key.** The cloud copies are gone.
  This is a feature and its cost.
