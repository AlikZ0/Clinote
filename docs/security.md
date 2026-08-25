# Security model

## 1. Assets, ranked

1. Client records and files (names, notes, x-rays, PDFs) — highest.
2. Encryption keys and passphrases.
3. Account credentials and sessions.
4. Backup artifacts in object storage.
5. Account/billing metadata.

## 2. Trust boundaries

```
[user device]  trusted for plaintext, holds keys
      │  HTTPS + ciphertext
[API]          trusted for routing/authz, NOT for plaintext client data
      │
[Postgres]     metadata + ciphertext envelopes
[S3-compatible] ciphertext objects, private, no public ACL ever
[email provider] untrusted — never receives client PII
[billing provider] untrusted for client data — receives account id + price only
[analytics]    untrusted — receives event names, never content
```

## 3. Authentication (§35)

- Email + password. Passwords hashed with Argon2id (server-side; this is a
  standard library, not custom crypto).
- Sessions: short-lived access token (JWT, 15 min) + rotating refresh token
  stored as an `HttpOnly; Secure; SameSite=Strict` cookie, with reuse detection
  that revokes the family.
- Password reset: single-use, 30-minute, constant-time-compared token; the reset
  email reveals nothing about account existence.
- Rate limits: login, register, reset, and token refresh are limited per IP and
  per account with progressive delay.
- The architecture leaves room for Google/Apple OIDC: identity is a separate
  `identities` table keyed by (provider, subject), not a column on `users`.

### What Phase 7 implemented

| Control                                                                | Where                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------- |
| Argon2id hashing (19 MiB, t=2, p=1)                                    | `apps/api/src/auth/password.ts`                      |
| Access token: HS256 JWT, 15 min, `sub` + `sid`                         | `apps/api/src/auth/tokens.ts`                        |
| Refresh token: 256-bit opaque, stored as SHA-256, rotated on every use | `apps/api/src/auth/service.ts`                       |
| Reuse detection revoking the whole family                              | `AuthService.refresh`                                |
| Password reset: single-use, hashed at rest, expiring                   | `AuthService.requestPasswordReset` / `resetPassword` |
| Rate limits on register/login/reset                                    | `apps/api/src/auth/routes.ts`                        |
| Route guard                                                            | `apps/api/src/plugins/authenticate.ts`               |

Three details worth stating because they are easy to lose in a refactor:

- **Login times are equalised.** When the email is unknown the service still
  verifies against a throwaway hash, so "no such account" and "wrong password"
  take the same time and return the same body. Registration cannot hide that an
  address is taken, and does not try to; it just says nothing more.
- **A password reset ends every session.** Changing a password because it may be
  known to someone else is pointless if their session survives.
- **The refresh cookie is `HttpOnly; SameSite=Strict; Path=/api/v1/auth`.**
  Script never reads it, and it is only sent to the four routes that need it.
  This is why the API must be served from the same origin as the app
  (docs/deployment.md §1); a cross-site cookie would have to be `SameSite=None`,
  which is exactly the setting CSRF exploits.

## 4. Authorization

Every request resolves `(userId, workspaceId, role)` and every data access is
scoped by it in the query itself — no post-filtering in application code.
Business roles (§42) map to a permission set that is checked by a single
`requirePermission()` guard.

## 5. Transport and storage

- HTTPS only, HSTS, secure cookies, CSP without `unsafe-inline` in production.
- Object storage buckets are private; every read/write goes through a
  short-lived signed URL scoped to one object and one method (§51).
- No backup is ever reachable by an unauthenticated URL.
- Database at rest encryption at the infrastructure level, in addition to the
  application-level envelope encryption.

## 6. Input validation

Every route validates its body, query and params with a zod schema from
`packages/types`. Unknown fields are stripped. Size limits are enforced before
parsing. The same schemas validate on the client, so the contract cannot drift.

## 7. Logging and privacy (§51, §53, §78)

Forbidden in logs, traces, metrics, analytics and audit records:

- client first/last name, phone, email, notes
- file names, thumbnails, blob content
- appointment titles
- encryption keys, passphrases, tokens, signed URLs

Allowed: user id, workspace id, device id, entity **type**, opaque entity id,
sizes, durations, status codes, error codes.

A logging middleware redacts a deny-list of field names as a second line of
defence, and a unit test asserts that the serializer drops them.

Analytics events are limited to `app_open`, `backup_started`,
`backup_completed`, `subscription_started` (§53).

## 8. Audit log (§43, §78)

Business only. Records `user, action, timestamp, resourceType, resourceId,
workspaceId, ip, userAgent` — never content. Append-only; the port has no
update and no delete, and neither does the schema.

Two kinds of entry, and the second is the interesting one:

1. **Actions the server performs itself** — a sign-in, an invitation, a role
   change, a backup.
2. **Data actions derived from the sync envelopes the server already relays.**
   An envelope carries entity type, entity id, device and `baseHlc`; that is
   enough to say "Anna added a client at 14:02" and not enough to say who the
   client is. `baseHlc === null` means the sender had no previous version,
   which is exactly what a creation is.

The derivation matters because the alternative — having devices _report_ what
they did — would disclose to the server exactly what the encryption is there to
keep from it. The log gains nothing the relay did not already know.

Only creations are logged for works, files and appointments. A log that records
every edit is noise, and noise gets ignored, which is worse than a shorter log.

A personal stream writes no audit entries at all: a single-person account has
nobody to be accountable to, and logging their own actions back at them would
be surveillance rather than an audit.

## 8a. Roles and permissions (§42)

Roles are names for sets of permissions. Code asks whether a member _may_ do
something (`can(role, 'members.manage')`), never what their role is called, so
a future custom role changes one table and nothing else.

| Role      | Read | Write | Delete | Appointments | Invite | Manage members | Audit | Rename workspace |
| --------- | ---- | ----- | ------ | ------------ | ------ | -------------- | ----- | ---------------- |
| Viewer    | ✓    |       |        |              |        |                |       |                  |
| Assistant | ✓    | ✓     |        | ✓            |        |                |       |                  |
| Doctor    | ✓    | ✓     | ✓      | ✓            |        |                |       |                  |
| Admin     | ✓    | ✓     | ✓      | ✓            | ✓      | ✓              | ✓     |                  |
| Owner     | ✓    | ✓     | ✓      | ✓            | ✓      | ✓              | ✓     | ✓                |

The set is strictly nested, and a test enforces that: a gap would mean a
_demotion_ could grant a permission, which nobody would think to test for.

Two rules exist to stop an admin taking a practice from its owner: an admin
cannot change the owner's role, and cannot remove the owner.

Every role has `sync.participate`, including Viewer — a member who cannot
receive envelopes is a member of nothing. Writing is separate, and the server
enforces it: a Viewer's `POST /sync/push` is refused with `403`, because a
modified client would otherwise simply push anyway.

## 9. Abuse and quotas

Per-account limits on: envelope push rate, backup init rate, storage bytes,
device registrations, notification subscriptions. Exceeding a limit returns a
typed error, not a generic 500.

## 10. Dependency and supply chain

Lockfile committed and installed with `--frozen-lockfile`; `pnpm audit` in CI;
the crypto package has zero runtime dependencies.

**No package runs an install script.** `pnpm.onlyBuiltDependencies` is an
explicit empty list, so a dependency that wants to execute code at install time
has to be added to it in a reviewed change rather than inherited silently. The
one package that asks (esbuild) works without it, because its native binary
arrives as a platform-specific package instead.

`pnpm.overrides` pins `esbuild` to the patched line: a build tool reached
through two different paths would otherwise resolve to two versions, and the
older one carried an advisory.

## 11. Incident handling

Security-relevant events (new device, password change, failed-login burst,
restore performed) trigger a transactional email to the account owner. These are
the only emails users cannot disable.

## 12. Review checklist per phase

- new route → authn, authz, validation, rate limit, no PII in logs;
- new entity → tombstone, HLC, outbox, encryption at rest in transit to cloud;
- new email/push → assert no client PII in the payload;
- new dependency → justification and audit.

## 13. Response hardening (Phase 15)

**API.** Every response carries `X-Content-Type-Options`, `X-Frame-Options`,
`Referrer-Policy: no-referrer`, a `default-src 'none'` CSP, `Permissions-Policy`
and the two `Cross-Origin-*` headers; production adds HSTS. Written out in
`apps/api/src/plugins/security.ts` rather than pulled from a header middleware:
this API serves JSON to one first-party SPA, so most of a general-purpose set is
irrelevant, and the few headers that matter are worth seeing with the reason
next to each. It is also one fewer dependency in a product whose threat model
names supply chain.

Everything except the public plan catalogue and the health probes is
`no-store`. Not a formality: responses carry wrapped key material, sealed
workspace keys and presigned URLs.

**App.** A strict CSP: `script-src 'self'` with a per-build SHA-256 hash for the
inline script Nuxt writes into the page, and no `'unsafe-inline'`. The hashes
are computed after the HTML exists (`apps/web/build/csp.ts`) because the inline
content changes every build. The policy ships in the page rather than a header,
because Clinote is a static bundle people self-host on whatever web server they
already run — a policy that only exists in an nginx snippet is one most
deployments will not have. `X-Frame-Options` covers what a meta tag cannot
express.

**Proxies.** `TRUST_PROXY` is the number of reverse proxies in front of the
process, and defaults to zero. `request.ip` is what the rate limiter buckets by
and what the audit log records; setting this to "trust everything" would let a
client choose both.

## 14. The checklist, executable

`apps/api/src/security/access.test.ts` and
`apps/api/src/security/redaction.test.ts` are the pen-test checklist in a form
that runs. They cover: reaching another account's backups, devices, keys and
envelopes by id; `alg: none`, wrong-secret, wrong-audience and expired tokens;
refresh-token reuse and sign-out; cookie flags; oversized bodies; a non-uuid id
in a path; a forged billing webhook; password and token redaction across every
flow that carries them; generic 5xx bodies; and identical answers for known and
unknown accounts.

The reason they are tests and not a document: a checklist gets read once, and a
test runs on every commit. `docs/threat-model.md` says what each one is for.
