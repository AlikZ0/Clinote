/**
 * Hybrid logical clock.
 *
 * Wall clocks disagree across devices, so record ordering during sync uses an
 * HLC instead of `updatedAt` (docs/local-first.md §7, docs/sync.md §5).
 *
 * Wire format: `<wallMillis padded to 15>:<counter padded to 5>:<deviceId>`
 * — padded so that lexicographic comparison equals chronological comparison,
 * which lets the string be used directly as an IndexedDB / SQL sort key.
 */

const WALL_WIDTH = 15
const COUNTER_WIDTH = 5
const MAX_COUNTER = 99_999
/** Reject remote timestamps this far ahead of us; a broken clock must not win forever. */
export const MAX_CLOCK_DRIFT_MS = 60 * 60 * 1000

export interface HlcParts {
  wallMillis: number
  counter: number
  deviceId: string
}

export function formatHlc(parts: HlcParts): string {
  return [
    String(parts.wallMillis).padStart(WALL_WIDTH, '0'),
    String(parts.counter).padStart(COUNTER_WIDTH, '0'),
    parts.deviceId,
  ].join(':')
}

export function parseHlc(value: string): HlcParts {
  const segments = value.split(':')
  if (segments.length < 3) throw new Error(`Malformed HLC: ${value}`)
  const [wall, counter, ...rest] = segments as [string, string, ...string[]]
  const wallMillis = Number(wall)
  const counterValue = Number(counter)
  if (!Number.isFinite(wallMillis) || !Number.isFinite(counterValue)) {
    throw new Error(`Malformed HLC: ${value}`)
  }
  return { wallMillis, counter: counterValue, deviceId: rest.join(':') }
}

/** Total order. Negative when `a` happened before `b`. */
export function compareHlc(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export class HybridClock {
  private wallMillis = 0
  private counter = 0

  constructor(
    private readonly deviceId: string,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Timestamp for a local mutation. Monotonic even if the wall clock steps back. */
  tick(): string {
    const wall = this.now()
    if (wall > this.wallMillis) {
      this.wallMillis = wall
      this.counter = 0
    } else {
      this.counter += 1
      this.assertCounter()
    }
    return formatHlc({
      wallMillis: this.wallMillis,
      counter: this.counter,
      deviceId: this.deviceId,
    })
  }

  /** Merges a received timestamp so that our next tick is causally after it. */
  receive(remote: string): string {
    const parsed = parseHlc(remote)
    const wall = this.now()
    if (parsed.wallMillis - wall > MAX_CLOCK_DRIFT_MS) {
      throw new Error('Remote HLC exceeds the accepted clock drift')
    }
    const maxWall = Math.max(wall, this.wallMillis, parsed.wallMillis)
    if (maxWall === this.wallMillis && maxWall === parsed.wallMillis) {
      this.counter = Math.max(this.counter, parsed.counter) + 1
    } else if (maxWall === this.wallMillis) {
      this.counter += 1
    } else if (maxWall === parsed.wallMillis) {
      this.counter = parsed.counter + 1
    } else {
      this.counter = 0
    }
    this.wallMillis = maxWall
    this.assertCounter()
    return formatHlc({
      wallMillis: this.wallMillis,
      counter: this.counter,
      deviceId: this.deviceId,
    })
  }

  private assertCounter(): void {
    if (this.counter > MAX_COUNTER) {
      throw new Error('HLC counter overflow: more than 100k events in one millisecond')
    }
  }
}
