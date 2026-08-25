/**
 * Content Security Policy for a static bundle (docs/security.md §13).
 *
 * Nuxt writes the runtime config into an inline `<script>` in the generated
 * HTML, so `script-src 'self'` alone stops the app from starting — the config
 * never runs and nothing has a base URL. There are three ways out and only one
 * of them is honest:
 *
 *   - `'unsafe-inline'`: gives up the directive that matters most;
 *   - a nonce: needs a server that renders the page per request, which a
 *     local-first bundle on a CDN does not have;
 *   - the hash of each inline script, computed for the build that produced it.
 *
 * The third is what this does. The content changes every build (the build id is
 * random), so the hashes cannot live in a config file and are written into the
 * policy after the HTML exists.
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Matches a `<script>` with no `src`: the ones a hash has to cover. */
const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g

export function hashInlineScripts(html: string): string[] {
  const hashes = new Set<string>()
  for (const [, body] of html.matchAll(INLINE_SCRIPT)) {
    // The hash covers the exact bytes between the tags, with no normalisation:
    // that is what the browser hashes, and any tidying here would silently
    // produce a policy that blocks the very script it was written for.
    hashes.add(
      `'sha256-${createHash('sha256')
        .update(body ?? '', 'utf8')
        .digest('base64')}'`,
    )
  }
  return [...hashes]
}

/**
 * Puts the hashes into the `script-src` directive of an existing policy.
 *
 * Returns the HTML unchanged when there is no policy to extend — a page
 * without one is not a page to invent one for.
 */
export function applyScriptHashes(html: string): string {
  const hashes = hashInlineScripts(html)
  if (hashes.length === 0) return html

  return html.replace(
    /(content=")([^"]*\bscript-src 'self')([^"]*")/,
    (match, before: string, directive: string, after: string) =>
      match.includes('sha256-') ? match : `${before}${directive} ${hashes.join(' ')}${after}`,
  )
}

function* htmlFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) yield* htmlFiles(path)
    else if (entry.endsWith('.html')) yield path
  }
}

/** Rewrites every generated page in place. Called from the build. */
export function applyScriptHashesToDirectory(directory: string): number {
  let rewritten = 0
  for (const file of htmlFiles(directory)) {
    const html = readFileSync(file, 'utf8')
    const updated = applyScriptHashes(html)
    if (updated !== html) {
      writeFileSync(file, updated)
      rewritten += 1
    }
  }
  return rewritten
}
