/**
 * Log redaction (docs/security.md §7).
 *
 * No client PII, no keys, no tokens, no signed URLs may reach a log sink. This
 * is a second line of defence: call sites are not supposed to pass these in the
 * first place, and a unit test asserts the redaction holds.
 */
export const REDACTED_FIELDS = [
  'firstName',
  'lastName',
  'phone',
  'email',
  'notes',
  'description',
  'title',
  'name',
  'fileName',
  'payload',
  'blob',
  'thumbnail',
  'password',
  'passphrase',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'cookie',
  'uploadUrl',
  'downloadUrl',
  'salt',
  'wrappedDekSync',
  'wrappedDekRecovery',
] as const

/** pino `redact` paths: top level, one level of nesting, and the usual carriers. */
export const redactPaths = [
  ...REDACTED_FIELDS,
  ...REDACTED_FIELDS.map((field) => `*.${field}`),
  ...REDACTED_FIELDS.map((field) => `req.headers.${field}`),
  ...REDACTED_FIELDS.map((field) => `body.${field}`),
]
