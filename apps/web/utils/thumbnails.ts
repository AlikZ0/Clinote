/**
 * Thumbnail generation (docs/indexeddb.md §4, docs/mobile.md §4).
 *
 * The original is never modified: an x-ray must not be recompressed. This only
 * produces a small preview so that lists never load originals.
 */
export const THUMBNAIL_MAX_EDGE = 320
export const THUMBNAIL_QUALITY = 0.72

export function canHaveThumbnail(mimeType: string): boolean {
  return mimeType.startsWith('image/')
}

/**
 * Returns null when a preview cannot be produced — an unsupported type, a
 * browser without `createImageBitmap`, or a decode failure. Callers fall back
 * to a type icon; a missing thumbnail is never an error.
 */
export async function createThumbnail(source: Blob): Promise<Blob | null> {
  if (!canHaveThumbnail(source.type)) return null
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return null

  let bitmap: ImageBitmap | null = null
  try {
    // `from-image` applies the EXIF orientation, so photos taken on a phone are
    // not stored rotated (docs/mobile.md §2).
    bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' })

    const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height

    const context = canvas.getContext('2d')
    if (!context) return null
    context.drawImage(bitmap, 0, 0, width, height)

    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/jpeg', THUMBNAIL_QUALITY)
    })
  } catch {
    return null
  } finally {
    bitmap?.close()
  }
}
