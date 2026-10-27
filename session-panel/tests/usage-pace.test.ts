import { describe, expect, test } from 'claude-code/testing'

import { UsagePace, WINDOW_MS } from '../hooks/UsagePace'

// Fixed local times, so the labels read the same in any time zone.
const NOW = new Date(2026, 9, 16, 12, 0).getTime() // Fri Oct 16 2026, 12:00 PM
const HOUR = 60 * 60 * 1000
const at = (ms: number) => new Date(ms).toISOString()

const fiveHour = (percentUsed: number, resetsInMs: number | null) =>
  UsagePace.of({ kind: 'five_hour', percentUsed, resetsAt: resetsInMs === null ? null : at(NOW + resetsInMs) }, NOW)

describe('UsagePace', () => {
  test('knows the 5-hour and weekly windows', async () => {
    expect(WINDOW_MS.five_hour).toBe(5 * HOUR)
    expect(WINDOW_MS.seven_day).toBe(7 * 24 * HOUR)
  })

  test('on track: projects linearly to the reset', async () => {
    // 3 of 5 hours gone (60%), 30% used: ~50% at reset.
    const pace = fiveHour(30, 2 * HOUR).pace()
    expect(pace?.verdict).toBe('on_track')
    expect(pace?.text).toBe('on track · ~50% at reset')
  })

  test('tight: 90 to 100% projected', async () => {
    // 60% gone, 57% used: ~95% at reset.
    const pace = fiveHour(57, 2 * HOUR).pace()
    expect(pace?.verdict).toBe('tight')
    expect(pace?.text).toBe('tight · ~95% at reset')
    expect(pace?.brief).toBe('tight, ~95%')
  })

  test('runs out: names when 100% is reached at the current rate', async () => {
    // 3 hours gone, 75% used: 25%/h, the other 25% in 1h -> 1:00 PM, before the 2:00 PM reset.
    const pace = fiveHour(75, 2 * HOUR).pace()
    expect(pace?.verdict).toBe('runs_out')
    expect(pace?.runsOutAt).toBe(NOW + HOUR)
    expect(pace?.text).toBe('runs out ~1:00 PM')
  })

  test('runs out on another day names the weekday', async () => {
    // Weekly: 4 of 7 days gone, 92% used: 23%/day, the other 8% in ~8.35h -> 8:20 PM today.
    const today = UsagePace.of({ kind: 'seven_day', percentUsed: 92, resetsAt: at(NOW + 3 * 24 * HOUR) }, NOW).pace()
    expect(today?.verdict).toBe('runs_out')
    expect(today?.text).toBe('runs out ~8:20 PM')
    // 2 of 7 days gone, 50% used: 25%/day, the other 50% in 2 days -> Sun 12:00 PM.
    const later = UsagePace.of({ kind: 'seven_day', percentUsed: 50, resetsAt: at(NOW + 5 * 24 * HOUR) }, NOW).pace()
    expect(later?.verdict).toBe('runs_out')
    expect(later?.text).toBe('runs out ~Sun 12:00 PM')
  })

  test('limit reached says when it resets', async () => {
    const pace = fiveHour(100, (2 * HOUR) + 10 * 60 * 1000).pace()
    expect(pace?.verdict).toBe('limit_reached')
    expect(pace?.text).toBe('limit reached · resets 2:10 PM')
    expect(pace?.brief).toBe('limit reached, resets 2:10 PM')
  })

  test('too early: under 10% of the window gone and under 10% used', async () => {
    // 20 minutes of 5 hours gone (~6.7%), 5% used.
    expect(fiveHour(5, 5 * HOUR - 20 * 60 * 1000).pace()).toBeNull()
    // Early but already 15% used: judged.
    expect(fiveHour(15, 5 * HOUR - 20 * 60 * 1000).pace()?.verdict).toBe('runs_out')
    // Under 10% used but past 10% of the window: judged.
    expect(fiveHour(5, 4 * HOUR).pace()?.verdict).toBe('on_track')
  })

  test('unknown kind: no window, no pace', async () => {
    const usage = UsagePace.of({ kind: 'spend_limit', percentUsed: 95, resetsAt: at(NOW + HOUR) }, NOW)
    expect(usage.windowMs).toBeNull()
    expect(usage.elapsed()).toBeNull()
    expect(usage.pace()).toBeNull()
  })

  test('missing or unreadable resetsAt: no pace', async () => {
    expect(fiveHour(50, null).elapsed()).toBeNull()
    expect(fiveHour(50, null).pace()).toBeNull()
    const bad = UsagePace.of({ kind: 'five_hour', percentUsed: 50, resetsAt: 'not a date' }, NOW)
    expect(bad.pace()).toBeNull()
  })

  test('elapsed is clamped to the window', async () => {
    // Reset further out than the window: 0, and nothing to project from.
    expect(fiveHour(50, 6 * HOUR).elapsed()).toBe(0)
    expect(fiveHour(50, 6 * HOUR).pace()).toBeNull()
    // Reset already past: 1, the projection is the usage itself.
    expect(fiveHour(40, -HOUR).elapsed()).toBe(1)
    expect(fiveHour(40, -HOUR).pace()?.text).toBe('on track · ~40% at reset')
    expect(Math.abs((fiveHour(40, 2 * HOUR).elapsed() ?? 0) - 0.6) < 1e-9).toBe(true)
  })
})
