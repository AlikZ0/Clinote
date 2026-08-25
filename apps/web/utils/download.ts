/**
 * Hands a generated file to the user.
 *
 * The archive is built in the browser and never leaves the device, so this is
 * an object URL rather than a request. On iOS Safari the `download` attribute
 * is ignored and the file opens in a new tab for the share sheet — expected,
 * and the reason nothing here assumes a filesystem (docs/mobile.md §2).
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()

  // Revoking immediately cancels the download on some browsers; the URL is
  // released once the transfer has certainly started.
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
