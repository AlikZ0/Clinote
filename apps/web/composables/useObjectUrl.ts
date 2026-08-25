/**
 * Object URL lifecycle.
 *
 * Every `createObjectURL` pins its Blob in memory until it is revoked, which on
 * a phone viewing x-rays is the difference between working and a crashed tab
 * (docs/mobile.md §2).
 */
export function useObjectUrl() {
  const url = ref<string | null>(null)

  function set(blob: Blob | null): void {
    release()
    url.value = blob ? URL.createObjectURL(blob) : null
  }

  function release(): void {
    if (url.value) URL.revokeObjectURL(url.value)
    url.value = null
  }

  onBeforeUnmount(release)

  return { url, set, release }
}
