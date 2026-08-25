/**
 * Access and refresh tokens (docs/security.md §3).
 *
 * Access token: short-lived signed JWT, carried in the Authorization header.
 * Refresh token: opaque random bytes in an HttpOnly cookie, stored hashed and
 * rotated on every use, with reuse detection at the family level.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'

export const TOKEN_ISSUER = 'clinote'
export const TOKEN_AUDIENCE = 'clinote-app'
export const REFRESH_COOKIE = 'clinote_rt'

export interface AccessTokenClaims {
  userId: string
  sessionId: string
}

export function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  secret: string,
  ttlSeconds: number,
): Promise<string> {
  return new SignJWT({ sid: claims.sessionId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId)
    .setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secretKey(secret))
}

export async function verifyAccessToken(
  token: string,
  secret: string,
): Promise<AccessTokenClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      issuer: TOKEN_ISSUER,
      audience: TOKEN_AUDIENCE,
      algorithms: ['HS256'],
    })
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null
    return { userId: payload.sub, sessionId: payload.sid }
  } catch {
    return null
  }
}

/** 256 bits of entropy; the value is shown to the client exactly once. */
export function createRefreshToken(): string {
  return randomBytes(32).toString('base64url')
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Constant-time comparison for anything an attacker can submit repeatedly. */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
