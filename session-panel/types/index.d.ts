export type Stats = {
  turn: number
  speed: number | null
  turnCost: number | null
  total: number
  context: number
  costAtStart: number
}

export type Limit = {
  kind: string
  percentUsed: number
  resetsAt: string | null
}

export type Cache = {
  expiresAt: number | null
  secondsLeft: number | null
}

/** Where the stats are drawn: the side pane, or the band above the prompt. */
export type Placement = 'pane' | 'band'

declare module 'claude-code' {
  interface PluginState {
    'session-panel': {
      stats: Stats
      cache: Cache
      isBusy: boolean
      warned: number
      limits: Limit[]
      placement: Placement
      isBandHidden: boolean
    }
    /** Read only: the cache deadline another mod ("Cache") publishes, used when this mod has none yet. */
    Cache: { expiresAt: number | null }
    /** Read only: published by the project-timer mod (labels are pre-formatted). */
    'project-timer': { summary: { project: string; total: string; today: string; session: string | null } | null }
  }
}
