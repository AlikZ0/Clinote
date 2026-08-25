/** Presentation helpers shared by the screens. */

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(1)} ${units[unit]}`
}

/** Whole days between an ISO timestamp and now; negative values clamp to 0. */
export function daysSince(iso: string, now: Date = new Date()): number {
  const elapsed = now.getTime() - Date.parse(iso)
  return Math.max(0, Math.floor(elapsed / 86_400_000))
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso)
  return `${date.toISOString().slice(0, 10)} ${date.toTimeString().slice(0, 5)}`
}
