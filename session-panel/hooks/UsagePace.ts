// Whether a rate-limit window is on pace to run out before it resets: a straight-line
// projection of the usage so far over the time the window has run. Pure: the caller
// hands in the time, so the pane recomputes it on every render and tests fix it.

export type PaceLimit = {
  kind: string
  percentUsed: number
  resetsAt: string | null
}

export type PaceVerdict = 'on_track' | 'tight' | 'runs_out' | 'limit_reached'

export type Pace = {
  verdict: PaceVerdict
  /** Usage projected at the reset, in percent: percentUsed / elapsed. */
  projected: number
  /** When usage reaches 100% at the current rate (ms); set for `runs_out` only. */
  runsOutAt: number | null
  /** The verdict in plain words: `on track · ~68% at reset`, `runs out ~3:40 PM`. */
  text: string
  /** The same, short enough for one line of stats: `on track, ~68%`, `runs out ~3:40 PM`. */
  brief: string
}

const HOUR_MS = 60 * 60 * 1000

/** Window lengths by kind; any other kind (a gateway's spend_limit) has no known window. */
export const WINDOW_MS: Record<string, number> = {
  five_hour: 5 * HOUR_MS,
  seven_day: 7 * 24 * HOUR_MS,
}

// Too early to judge: less than this share of the window gone and less than this much used.
const EARLY_ELAPSED = 0.1
const EARLY_USED = 10
// Projected usage at reset from which the window reads as tight.
const TIGHT_FROM = 90

/**
 * "4:10 PM" today, "Thu 9:00 AM" on another day, in the machine's time zone;
 * '' for an unreadable time.
 */
export const clockLabel = (at: number, now: number) => {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const time = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  const sameDay = date.toDateString() === new Date(now).toDateString()
  return sameDay ? time : `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${time}`
}

export class UsagePace {
  readonly limit: PaceLimit
  /** The window's length in ms; null when the kind has no known window. */
  readonly windowMs: number | null
  readonly now: number

  constructor(limit: PaceLimit, windowMs: number | null, now: number) {
    this.limit = limit
    this.windowMs = windowMs
    this.now = now
  }

  /** The pace of a limit by its kind's window length. */
  static of(limit: PaceLimit, now: number) {
    return new UsagePace(limit, WINDOW_MS[limit.kind] ?? null, now)
  }

  /** The reset as ms since the epoch; null when absent or unreadable. */
  resetMs(): number | null {
    if (!this.limit.resetsAt) return null
    const at = new Date(this.limit.resetsAt).getTime()
    return Number.isNaN(at) ? null : at
  }

  /**
   * Share of the window gone, 0 to 1: 1 − (resetsAt − now) / window, clamped.
   * Null without a known window or a reset time.
   */
  elapsed(): number | null {
    const reset = this.resetMs()
    if (this.windowMs === null || this.windowMs <= 0 || reset === null) return null
    const fraction = 1 - (reset - this.now) / this.windowMs
    return Math.min(1, Math.max(0, fraction))
  }

  /** The verdict; null when there is nothing to say (no window, no reset, too early). */
  pace(): Pace | null {
    const reset = this.resetMs()
    const elapsed = this.elapsed()
    if (reset === null || elapsed === null) return null

    const used = this.limit.percentUsed
    if (used >= 100) {
      return {
        verdict: 'limit_reached',
        projected: used,
        runsOutAt: null,
        text: `limit reached · resets ${clockLabel(reset, this.now)}`,
        brief: `limit reached, resets ${clockLabel(reset, this.now)}`,
      }
    }
    if (elapsed < EARLY_ELAPSED && used < EARLY_USED) return null
    // No time gone yet: no rate to project from.
    if (elapsed <= 0) return null

    const projected = used / elapsed
    if (projected >= 100 && used > 0) {
      // rate = used / elapsed time; the rest of the 100% at that rate.
      const elapsedMs = elapsed * (this.windowMs as number)
      const runsOutAt = this.now + ((100 - used) * elapsedMs) / used
      if (runsOutAt <= reset) {
        return {
          verdict: 'runs_out',
          projected,
          runsOutAt,
          text: `runs out ~${clockLabel(runsOutAt, this.now)}`,
          brief: `runs out ~${clockLabel(runsOutAt, this.now)}`,
        }
      }
    }
    if (projected >= TIGHT_FROM) {
      return {
        verdict: 'tight',
        projected,
        runsOutAt: null,
        text: `tight · ~${Math.min(99, Math.round(projected))}% at reset`,
        brief: `tight, ~${Math.min(99, Math.round(projected))}%`,
      }
    }
    return {
      verdict: 'on_track',
      projected,
      runsOutAt: null,
      text: `on track · ~${Math.round(projected)}% at reset`,
      brief: `on track, ~${Math.round(projected)}%`,
    }
  }
}
