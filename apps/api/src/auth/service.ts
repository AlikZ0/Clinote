/**
 * Authentication use cases (docs/security.md §3).
 *
 * Everything that decides *whether* someone is who they claim lives here, in
 * one file, so the rules can be read in one sitting.
 */
import { randomUUID } from 'node:crypto'
import { AppError } from '@clinote/shared'
import type { Entitlement, User } from '@clinote/types'
import type { Env } from '../env'
import { resolveEntitlement } from '../entitlements'
import type { SessionRecord, Stores, UserRecord } from '../storage'
import { hashPassword, verifyPassword } from './password'
import { createRefreshToken, hashToken, signAccessToken } from './tokens'

export interface SessionContext {
  ip: string | null
  userAgent: string | null
  deviceId: string | null
}

export interface AuthResult {
  user: User
  entitlement: Entitlement
  accessToken: string
  expiresIn: number
  refreshToken: string
  refreshExpiresAt: Date
}

/**
 * A dummy hash to verify against when the account does not exist.
 *
 * Without it, "unknown email" returns in microseconds while "wrong password"
 * takes ~50ms of Argon2, and that difference enumerates accounts.
 */
let dummyHashPromise: Promise<string> | null = null
function dummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword(`no-such-user-${randomUUID()}`)
  return dummyHashPromise
}

export class AuthService {
  constructor(
    private readonly stores: Stores,
    private readonly env: Env,
  ) {}

  async register(
    input: { email: string; password: string; name?: string },
    context: SessionContext,
  ) {
    const existing = await this.stores.users.findByEmail(input.email)
    if (existing) {
      // Registration cannot hide that an address is taken, but it can decline
      // to say anything more than that.
      throw new AppError('validation_failed', {
        message: 'An account with this email already exists. Try signing in instead.',
      })
    }

    const now = new Date().toISOString()
    const user = await this.stores.users.create({
      id: randomUUID(),
      email: input.email.toLowerCase(),
      passwordHash: await hashPassword(input.password),
      name: input.name ?? null,
      locale: null,
      timezone: null,
      emailVerifiedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    })

    return this.issue(user, context)
  }

  async login(input: { email: string; password: string }, context: SessionContext) {
    const user = await this.stores.users.findByEmail(input.email)

    const matches = user
      ? await verifyPassword(user.passwordHash, input.password)
      : await verifyPassword(await dummyHash(), input.password)

    if (!user || !matches) {
      throw new AppError('unauthenticated', {
        message: 'That email and password do not match an account.',
      })
    }

    return this.issue(user, context)
  }

  /**
   * Rotates the refresh token.
   *
   * A token that was already rotated away is either a replay or a theft; either
   * way the safe response is to revoke the entire chain and force a sign-in.
   */
  async refresh(refreshToken: string, context: SessionContext) {
    const session = await this.stores.sessions.findByTokenHash(hashToken(refreshToken))
    if (!session) {
      throw new AppError('unauthenticated', { message: 'Please sign in again.' })
    }

    if (session.revokedAt) {
      await this.stores.sessions.revokeFamily(session.familyId)
      throw new AppError('unauthenticated', {
        message: 'Your session was ended for security reasons. Please sign in again.',
      })
    }

    if (Date.parse(session.expiresAt) <= Date.now()) {
      await this.stores.sessions.revoke(session.id)
      throw new AppError('unauthenticated', {
        message: 'Your session expired. Please sign in again.',
      })
    }

    const user = await this.stores.users.findById(session.userId)
    if (!user) {
      await this.stores.sessions.revokeFamily(session.familyId)
      throw new AppError('unauthenticated', { message: 'Please sign in again.' })
    }

    await this.stores.sessions.revoke(session.id)
    return this.issue(user, context, session.familyId)
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return
    const session = await this.stores.sessions.findByTokenHash(hashToken(refreshToken))
    // Signing out ends the chain, not just the current token.
    if (session) await this.stores.sessions.revokeFamily(session.familyId)
  }

  /**
   * Always succeeds from the caller's point of view: whether an address has an
   * account is not something an unauthenticated request may learn.
   */
  async requestPasswordReset(email: string): Promise<{ token: string; userId: string } | null> {
    const user = await this.stores.users.findByEmail(email)
    if (!user) return null

    await this.stores.passwordResets.invalidateForUser(user.id)

    const token = createRefreshToken()
    await this.stores.passwordResets.create({
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + this.env.PASSWORD_RESET_TTL_MINUTES * 60_000).toISOString(),
      usedAt: null,
      createdAt: new Date().toISOString(),
    })

    return { token, userId: user.id }
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const record = await this.stores.passwordResets.findByTokenHash(hashToken(token))
    const invalid = new AppError('validation_failed', {
      message: 'This reset link is no longer valid. Request a new one.',
    })

    if (!record || record.usedAt || Date.parse(record.expiresAt) <= Date.now()) throw invalid

    const user = await this.stores.users.findById(record.userId)
    if (!user) throw invalid

    await this.stores.users.update(user.id, { passwordHash: await hashPassword(password) })
    await this.stores.passwordResets.markUsed(record.tokenHash, new Date().toISOString())
    // A password change ends every session: that is the point of changing it.
    await this.stores.sessions.revokeAllForUser(user.id)
  }

  async me(userId: string): Promise<{ user: User; entitlement: Entitlement }> {
    const user = await this.stores.users.findById(userId)
    if (!user) throw new AppError('unauthenticated', { message: 'Please sign in again.' })
    return { user: toPublicUser(user), entitlement: await resolveEntitlement(this.stores, userId) }
  }

  private async issue(
    user: UserRecord,
    context: SessionContext,
    familyId: string = randomUUID(),
  ): Promise<AuthResult> {
    const refreshToken = createRefreshToken()
    const refreshExpiresAt = new Date(Date.now() + this.env.REFRESH_TOKEN_TTL_DAYS * 86_400_000)

    const session: SessionRecord = {
      id: randomUUID(),
      userId: user.id,
      refreshTokenHash: hashToken(refreshToken),
      familyId,
      deviceId: context.deviceId,
      ip: context.ip,
      userAgent: context.userAgent,
      createdAt: new Date().toISOString(),
      expiresAt: refreshExpiresAt.toISOString(),
      revokedAt: null,
    }
    await this.stores.sessions.create(session)

    return {
      user: toPublicUser(user),
      entitlement: await resolveEntitlement(this.stores, user.id),
      accessToken: await signAccessToken(
        { userId: user.id, sessionId: session.id },
        this.env.JWT_SECRET,
        this.env.ACCESS_TOKEN_TTL_SECONDS,
      ),
      expiresIn: this.env.ACCESS_TOKEN_TTL_SECONDS,
      refreshToken,
      refreshExpiresAt,
    }
  }
}

/** The password hash never leaves this process. */
export function toPublicUser(user: UserRecord): User {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    locale: user.locale,
    timezone: user.timezone,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt,
  }
}
