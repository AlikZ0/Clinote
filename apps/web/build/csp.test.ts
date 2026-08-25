import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { applyScriptHashes, hashInlineScripts } from './csp'

const POLICY = `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; object-src 'none'">`

describe('hashing the inline scripts', () => {
  it('hashes exactly the bytes the browser will hash', () => {
    const body = 'window.__NUXT__={};'
    const expected = `'sha256-${createHash('sha256').update(body).digest('base64')}'`

    expect(hashInlineScripts(`<script>${body}</script>`)).toEqual([expected])
  })

  it('ignores scripts that are loaded from a file', () => {
    // Those are covered by `'self'`; hashing them would be meaningless.
    expect(hashInlineScripts('<script src="/_nuxt/app.js"></script>')).toEqual([])
  })

  it('covers every inline script on the page, once each', () => {
    const html = `<script>a()</script><script>b()</script><script>a()</script>`
    expect(hashInlineScripts(html)).toHaveLength(2)
  })

  it('does not fold whitespace, because the browser does not either', () => {
    const [tight] = hashInlineScripts('<script>a()</script>')
    const [loose] = hashInlineScripts('<script>\n  a()\n</script>')
    expect(tight).not.toBe(loose)
  })
})

describe('rewriting the policy', () => {
  it('extends script-src and leaves the rest of the policy alone', () => {
    const html = `${POLICY}<script>window.x=1</script>`
    const updated = applyScriptHashes(html)

    expect(updated).toMatch(/script-src 'self' 'sha256-[^']+'/)
    expect(updated).toContain("default-src 'self'")
    expect(updated).toContain("object-src 'none'")
    // Never widened to make the problem go away.
    expect(updated).not.toContain('unsafe-inline')
  })

  it('is safe to run twice', () => {
    const html = `${POLICY}<script>window.x=1</script>`
    const once = applyScriptHashes(html)
    expect(applyScriptHashes(once)).toBe(once)
  })

  it('leaves a page with no policy untouched', () => {
    const html = '<html><script>window.x=1</script></html>'
    expect(applyScriptHashes(html)).toBe(html)
  })

  it('leaves a page with no inline script untouched', () => {
    const html = `${POLICY}<script src="/app.js"></script>`
    expect(applyScriptHashes(html)).toBe(html)
  })
})
