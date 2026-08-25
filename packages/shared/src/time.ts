/** Wall-clock helpers. Machine ordering uses the HLC in `hlc.ts`, not these. */

export type IsoDateTime = string

export function nowIso(): IsoDateTime {
  return new Date().toISOString()
}

export function toIso(value: Date | number | string): IsoDateTime {
  return new Date(value).toISOString()
}

/** Start of the local day, used by "today"/"tomorrow" calendar slices. */
export function startOfDay(value: Date): Date {
  const d = new Date(value)
  d.setHours(0, 0, 0, 0)
  return d
}

export function addDays(value: Date, days: number): Date {
  const d = new Date(value)
  d.setDate(d.getDate() + days)
  return d
}
