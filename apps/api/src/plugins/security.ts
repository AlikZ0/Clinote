/**
 * Response hardening (docs/security.md §13, docs/threat-model.md T7, T9).
 *
 * Written out rather than pulled from a helmet package on purpose. This API
 * serves JSON to one first-party SPA, so most of what a general-purpose header
 * middleware does is irrelevant here, and the few headers that matter are worth
 * seeing — with the reason next to each — instead of inheriting a default set
 * that changes under us. It is also one fewer dependency in a product whose
 * threat model names supply chain explicitly.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/** One year, and only over HTTPS, where the header means anything. */
const HSTS = 'max-age=31536000; includeSubDomains'

/**
 * A JSON API renders nothing and needs nothing.
 *
 * `default-src 'none'` means a response that somehow gets treated as a document
 * — a mis-set content type, a browser opening an endpoint directly — cannot
 * load a script, a style or an image, and `frame-ancestors 'none'` means it
 * cannot be framed.
 */
const CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"

/** Paths whose responses may be cached by shared caches. */
const CACHEABLE = new Set(['/api/v1/plans', '/health/live', '/health/ready'])

export interface SecurityHeaderOptions {
  /** HSTS is sent only in production: it is meaningless, and a nuisance, on http://localhost. */
  production: boolean
}

export function registerSecurityHeaders(
  app: FastifyInstance,
  options: SecurityHeaderOptions,
): void {
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('x-frame-options', 'DENY')
    reply.header('content-security-policy', CSP)
    // No URL of ours should ever appear in a third party's referer log; API
    // paths carry ids, and ids are not for sharing.
    reply.header('referrer-policy', 'no-referrer')
    reply.header('cross-origin-resource-policy', 'same-site')
    reply.header('cross-origin-opener-policy', 'same-origin')
    // Nothing here is a document that could ask for a camera or a location.
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=()')

    if (options.production) reply.header('strict-transport-security', HSTS)

    /**
     * Everything else is `no-store`.
     *
     * Not a formality: these responses carry wrapped key material, sealed
     * workspace keys, presigned upload and download URLs, and entitlement
     * snapshots. A proxy or a browser holding any of that on disk is exactly
     * the disclosure the rest of the design works to prevent.
     */
    if (!CACHEABLE.has(request.url.split('?')[0] ?? '')) {
      reply.header('cache-control', 'no-store')
      reply.header('pragma', 'no-cache')
    }

    return payload
  })
}
