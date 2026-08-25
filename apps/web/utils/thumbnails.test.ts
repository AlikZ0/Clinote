import { describe, expect, it } from 'vitest'
import { canHaveThumbnail, createThumbnail } from './thumbnails'

describe('thumbnails', () => {
  it('only attempts previews for images', () => {
    expect(canHaveThumbnail('image/jpeg')).toBe(true)
    expect(canHaveThumbnail('image/png')).toBe(true)
    expect(canHaveThumbnail('application/pdf')).toBe(false)
    expect(canHaveThumbnail('text/plain')).toBe(false)
  })

  it('returns null instead of throwing where the browser cannot decode', async () => {
    // No `createImageBitmap` and no DOM in this environment: a missing preview
    // is a fallback, never an error (docs/mobile.md §2).
    expect(await createThumbnail(new Blob(['x'], { type: 'image/jpeg' }))).toBeNull()
    expect(await createThumbnail(new Blob(['x'], { type: 'application/pdf' }))).toBeNull()
  })
})
