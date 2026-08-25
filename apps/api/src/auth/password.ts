/**
 * Password hashing (docs/security.md §3).
 *
 * Argon2id at the OWASP-recommended parameters. We do not invent hashing; this
 * is a thin wrapper so that call sites cannot get the parameters wrong.
 */
import { hash, verify, type Algorithm } from '@node-rs/argon2'

/**
 * `Algorithm.Argon2id`. The enum is an ambient const enum, which cannot be
 * imported as a value under `verbatimModuleSyntax`, so the value is named here.
 */
const ARGON2ID = 2 as Algorithm

const OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS)
}

/**
 * Returns false rather than throwing on a malformed hash: a corrupted row must
 * fail the login, not the request pipeline.
 */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password, OPTIONS)
  } catch {
    return false
  }
}
