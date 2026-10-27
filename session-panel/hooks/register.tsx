import { atom, read, update } from 'claude-code'
import type { ElementTable, EngineInterface, Register } from 'claude-code'

import type { Cache, Limit, Placement, Stats } from '../types'
import { UsagePace, clockLabel } from './UsagePace'
import type { PaceVerdict } from './UsagePace'

// Local fork of johnnyvizz's session-band (MIT): the same stats, drawn in a side pane
// or, after `/session_panel band`, in the band above the prompt.
const PANE = 'session-panel'
const TITLE = 'Session'

// Responses shorter than this are mostly tool-call stubs: their timing is noise.
const MIN_TOKENS = 20
// A response that arrived in one burst cannot be timed; such readings are dropped.
const MIN_SECONDS = 0.5
const MAX_SPEED = 1000

const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_WARN_S = 20 * 60
const CACHE_ALERT_S = 10 * 60
// Minutes left at which the cache expiry is announced, once each per answer.
const CACHE_NOTIFY_MINUTES = [10, 5] as const

const SPEED = '#8b8cf8'
const MONEY = '#4caf6e'
const MUTED = '#8a8f8c'
const CONTEXT = '#5fa8d3'
const CACHE = '#4fb3a9'
const WARN = '#e2a94e'
const ALERT = '#e0846b'

const stats = atom({ plugin: 'session-panel', key: 'stats' } as const, {
  turn: 0,
  speed: null,
  turnCost: null,
  total: 0,
  context: 0,
  costAtStart: 0,
} as Stats)

const cache = atom({ plugin: 'session-panel', key: 'cache' } as const, {
  expiresAt: null,
  secondsLeft: null,
} as Cache)

// Where the stats live: the side pane, or the band above the prompt, which leaves the
// side pane to Files and the rest. Kept across sessions in $.store.
const placement = atom({ plugin: 'session-panel', key: 'placement' } as const, 'pane' as Placement)
// `/session_panel` while the stats are in the band: hidden for the rest of the session.
const isBandHidden = atom({ plugin: 'session-panel', key: 'isBandHidden' } as const, false)

// A turn is running: the cache stays warm, so no countdown warnings.
const isBusy = atom({ plugin: 'session-panel', key: 'isBusy' } as const, false)
// The account's rate-limit windows (5-hour, weekly, a gateway's spend limit) from the last API response.
const limits = atom({ plugin: 'session-panel', key: 'limits' } as const, [])

// The smallest CACHE_NOTIFY_MINUTES already announced since the last answer; 0 none.
const warned = atom({ plugin: 'session-panel', key: 'warned' } as const, 0)

// The Cache mod's own deadline: seeds ours after a reload missed the last turn.complete.
const cacheModExpiresAt = atom({ plugin: 'Cache', key: 'expiresAt' } as const, null)
// Published by the project-timer mod for the session's project; null outside a Claude Code project.
const projectTime = atom({ plugin: 'project-timer', key: 'summary' } as const, null)

const ring = (color: string, glyph: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <circle cx="12" cy="12" r="10" fill="none" stroke="${color}" stroke-width="2"/>
    ${glyph}</svg>`

const SPEED_ICON = ring(
  SPEED,
  `<path d="M6.5 15a6 6 0 0 1 11 0" fill="none" stroke="${SPEED}" stroke-width="1.8" stroke-linecap="round"/>
   <path d="M12 15l3-4" stroke="${SPEED}" stroke-width="1.8" stroke-linecap="round"/>`,
)

const MONEY_ICON = ring(
  MONEY,
  `<text x="12" y="16.5" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="13" font-weight="600" fill="${MONEY}">$</text>`,
)

// The ring itself fills with the context, around a page of lines.
const contextIcon = (percent: number) => {
  const c = 2 * Math.PI * 10
  const filled = (Math.min(100, percent) / 100) * c
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <circle cx="12" cy="12" r="10" fill="none" stroke="${MUTED}" stroke-opacity="0.35" stroke-width="2"/>
    <circle cx="12" cy="12" r="10" fill="none" stroke="${CONTEXT}" stroke-width="2" stroke-linecap="round"
      stroke-dasharray="${filled.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 12 12)"/>
    <g stroke="${CONTEXT}" stroke-width="1.6" stroke-linecap="round">
      <path d="M8.5 9h7M8.5 12h7M8.5 15h4.5"/>
    </g></svg>`
}

// An hourglass: the prompt cache running out.
const cacheIcon = (color: string) =>
  ring(
    color,
    `<g fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">
       <path d="M8.5 6.5h7M8.5 17.5h7"/>
       <path d="M9.5 6.5c0 3 5 3.5 5 5.5s-5 2.5-5 5.5M14.5 6.5c0 3-5 3.5-5 5.5s5 2.5 5 5.5"/>
     </g>`,
  )

const pad = (n: number) => String(n).padStart(2, '0')

// The bars sit inline in a line of text: this many pixels across and down.
const BAR_W = 48
const BAR_H = 4

// A share used, as a bar: neutral unless the share is a warning.
const usageBar = (percent: number, color: string) => {
  const w = Math.round((Math.min(100, percent) / 100) * BAR_W)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BAR_W} ${BAR_H}" width="${BAR_W}" height="${BAR_H}">
    <rect width="${BAR_W}" height="${BAR_H}" rx="2" fill="${MUTED}" fill-opacity="0.3"/>
    <rect width="${w}" height="${BAR_H}" rx="2" fill="${color}"/></svg>`
}

const usd = (n: number) => `$${n.toFixed(2)}`

// The stats are one line of short segments that wraps as the room narrows: a band
// above the prompt reads them across, a thin sidebar stacks them. Cells between segments.
const SEGMENT_GAP = 3

// Last measured width, for `/session_panel width`; debug only.
let lastColumns: number | null = null

const LIMIT_NAMES: Record<string, string> = { five_hour: '5h', seven_day: 'Weekly', spend_limit: 'Spend' }
const LIMIT_WARN = 75
const LIMIT_ALERT = 90

const toLimit = (r: { kind: string; percentUsed: number; resetsAt?: string }): Limit => ({
  kind: r.kind,
  percentUsed: r.percentUsed,
  resetsAt: r.resetsAt ?? null,
})

// "resets 4:10 PM" today, "resets Thu 9:00 AM" later in the week, in the machine's time zone.
const resetLabel = (resetsAt: string | null, now: number) => {
  if (!resetsAt) return ''
  const label = clockLabel(new Date(resetsAt).getTime(), now)
  return label ? `resets ${label}` : ''
}

// Red only when the window runs out before it resets, amber when it will be tight.
const PACE_COLORS: Record<PaceVerdict, string | undefined> = {
  limit_reached: ALERT,
  runs_out: ALERT,
  tight: WARN,
  on_track: undefined,
}

// A limit's bar: the fill is the share used; the thin mark is where an even pace
// would be by now (the share of the window gone).
const paceBar = (percent: number, elapsed: number, color: string) => {
  const w = Math.round((Math.min(100, percent) / 100) * BAR_W)
  const x = Math.min(BAR_W - 1, Math.max(0, elapsed * BAR_W - 0.75))
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BAR_W} ${BAR_H}" width="${BAR_W}" height="${BAR_H}">
    <rect width="${BAR_W}" height="${BAR_H}" rx="2" fill="${MUTED}" fill-opacity="0.3"/>
    <rect width="${w}" height="${BAR_H}" rx="2" fill="${color}"/>
    <rect x="${x.toFixed(2)}" width="1.5" height="${BAR_H}" fill="${MUTED}"/></svg>`
}

const refresh = async ($: EngineInterface) => {
  const { cost, context, rateLimits } = await $.session.usage()
  await update($, limits, () => rateLimits.map(toLimit))
  const total = cost?.usd ?? 0
  await update($, stats, s => ({
    ...s,
    total,
    turnCost: total - s.costAtStart,
    context: context.percent ?? s.context,
  }))
}

// Built by notifier/build.sh (macOS): posts the warning under Claude's icon.
const NOTIFIER = 'notifier/Session Band.app/Contents/MacOS/session-band-notifier'
// The desktop app's id for a local Code session, as its claude:// links take it.
const HOST_SESSION = /^local_[A-Za-z0-9-]{1,64}$/

// This session as the desktop app knows it: its id and the title in its sidebar.
// Null outside the desktop app; the title null when its record cannot be read.
const desktopSession = async ($: EngineInterface) => {
  const id = await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')
  if (id === undefined || !HOST_SESSION.test(id)) return null

  const home = await $.env.get('HOME')
  const account = await $.env.get('CLAUDE_CODE_ACCOUNT_UUID')
  const org = await $.env.get('CLAUDE_CODE_ORGANIZATION_UUID')
  const record = `${home}/Library/Application Support/Claude/claude-code-sessions/${account}/${org}/${id}.json`
  const title = await $.fs.read(record).then(
    text => (JSON.parse(text) as { title?: unknown }).title,
    () => undefined,
  )

  return { id, title: typeof title === 'string' && title.trim() !== '' ? title.trim() : null }
}

// The notifier's system notification, titled with the project and the session, which
// opens this session when clicked. Without the notifier (not built, not macOS, or
// notifications not allowed), Claude Code's own notification, which also reaches
// the phone over Remote Control; it is skipped while the person is at this session,
// and then a toast says it instead.
const notifyCacheExpiry = async ($: EngineInterface, minutes: number) => {
  const project = (await $.session.cwd()).split('/').filter(Boolean).pop() ?? 'session'
  const message = `Prompt cache expires in ${minutes} min`

  const notifier = `${$.plugin.root}/${NOTIFIER}`
  if (await $.fs.exists(notifier)) {
    const session = await desktopSession($)
    const argv = [
      notifier,
      '-title',
      session?.title ? `${project} — ${session.title}` : project,
      '-message',
      message,
      '-group',
      `session-band-${session?.id ?? (await $.session.id())}`,
      ...(session ? ['-open', `claude://code/continue?session=${session.id}`] : []),
    ]
    // The first run waits while macOS asks whether to allow its notifications.
    const ran = await $.process.run(argv, { timeoutMs: 60_000 }).catch(() => null)
    if (ran?.exitCode === 0) return
  }

  const text = `${project}: ${message}`
  const sent = await $.tool
    .call({ tool: 'PushNotification', message: text, status: 'proactive' })
    .catch(() => null)
  const isDelivered =
    sent !== null &&
    sent.deny === undefined &&
    sent.isError !== true &&
    (sent.result.pushSent === true || sent.result.localSent === true)

  if (!isDelivered) $.ui.toast(`⏳ ${text}`, { timeoutMs: 30000 })
}

// The stats as one wrapping line of segments, for the pane and the band alike. Colour
// marks a warning only: a tight or lost limit, the cache running out, a full context.
const drawStats = async ($: EngineInterface, ui: ElementTable, columns: number) => {
  const { Box, Text } = ui
  const Svg = 'Svg' in ui ? ui.Svg : null
  const s = await read($, stats)
  const busy = await read($, isBusy)
  lastColumns = columns

  const time = await read($, projectTime)
  const timeSegments = time
    ? [
        <Text key="seg-time">
          <Text dimColor>{`${time.project} `}</Text>
          <Text bold>{time.total}</Text>
          <Text dimColor>{` ${time.today} today`}</Text>
        </Text>,
      ]
    : []

  const now = await $.clock.now()
  const limitSegments = (await read($, limits)).map(l => {
    const usage = UsagePace.of(l, now)
    const pace = usage.pace()
    const elapsed = usage.elapsed()
    // No verdict (no known window, no reset time, too early): coloured by the share used.
    const color = pace
      ? PACE_COLORS[pace.verdict]
      : l.percentUsed >= LIMIT_ALERT
        ? ALERT
        : l.percentUsed >= LIMIT_WARN
          ? WARN
          : undefined
    const reset = pace ? '' : resetLabel(l.resetsAt, now)
    const note = pace?.brief ?? reset

    return (
      <Box key={`seg-limit-${l.kind}`} flexDirection="row" columnGap={1} alignItems="center">
        <Text>
          <Text dimColor>{`${LIMIT_NAMES[l.kind] ?? l.kind} `}</Text>
          <Text bold color={color}>{`${l.percentUsed}%`}</Text>
        </Text>
        {Svg ? (
          <Svg
            source={
              elapsed === null
                ? usageBar(l.percentUsed, color ?? MUTED)
                : paceBar(l.percentUsed, elapsed, color ?? MUTED)
            }
            alt={`${l.kind} ${l.percentUsed}%`}
            width={BAR_W}
            height={BAR_H}
          />
        ) : null}
        {note ? (
          <Text color={color} dimColor={color === undefined}>
            {note}
          </Text>
        ) : null}
      </Box>
    )
  })

  if (s.turn === 0) {
    return (
      <Box key="stats" flexDirection="row" flexWrap="wrap" columnGap={SEGMENT_GAP} rowGap={0}>
        {timeSegments}
        {limitSegments}
        <Text key="seg-wait" dimColor>
          Stats appear after the first turn.
        </Text>
      </Box>
    )
  }

  const { secondsLeft } = await read($, cache)
  const level =
    busy || secondsLeft === null
      ? undefined
      : secondsLeft <= CACHE_ALERT_S
        ? ALERT
        : secondsLeft <= CACHE_WARN_S
          ? WARN
          : undefined
  const cacheText =
    busy ? '…'
    : secondsLeft === null ? '-'
    : secondsLeft === 0 ? 'expired'
    : `${pad(Math.floor(secondsLeft / 60))}:${pad(secondsLeft % 60)}`
  const contextColor = s.context >= 85 ? ALERT : s.context >= 65 ? WARN : undefined

  return (
    <Box key="stats" flexDirection="row" flexWrap="wrap" columnGap={SEGMENT_GAP} rowGap={0}>
      {timeSegments}
      {limitSegments}
      <Text key="seg-turn">
        <Text dimColor>Turn </Text>
        <Text bold>{String(s.turn)}</Text>
      </Text>
      <Text key="seg-speed">
        <Text dimColor>⚡ </Text>
        <Text bold>{s.speed === null ? '-' : String(s.speed)}</Text>
        <Text dimColor> tok/s</Text>
      </Text>
      <Text key="seg-turn-cost">
        <Text bold>{s.turnCost === null ? '-' : usd(s.turnCost)}</Text>
        <Text dimColor> turn</Text>
      </Text>
      <Text key="seg-total">
        <Text bold>{usd(s.total)}</Text>
        <Text dimColor> session</Text>
      </Text>
      <Text key="seg-cache">
        <Text color={level} dimColor={level === undefined}>
          ⧗{' '}
        </Text>
        <Text bold color={level}>
          {cacheText}
        </Text>
        <Text dimColor> cache</Text>
      </Text>
      <Text key="seg-context">
        <Text dimColor>◔ </Text>
        <Text bold color={contextColor}>{`${s.context}%`}</Text>
        <Text dimColor> context</Text>
      </Text>
    </Box>
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    await $.command.register({
      name: 'session_panel',
      description:
        'Show or hide the session stats; `band` or `pane` moves them; `demo <minutes>` previews the cache warning',
    })

    $.clock.every(1000, async () => {
      const expiresAt = (await read($, cache)).expiresAt ?? (await read($, cacheModExpiresAt))
      if (expiresAt === null) return

      const left = Math.max(0, Math.floor((expiresAt - (await $.clock.now())) / 1000))
      if (left !== (await read($, cache)).secondsLeft) {
        await update($, cache, c => ({ expiresAt: c.expiresAt ?? expiresAt, secondsLeft: left }))
      }

      const due = CACHE_NOTIFY_MINUTES.filter(m => left > 0 && left <= m * 60)
      if (due.length === 0 || (await read($, isBusy))) return

      const minutes = Math.min(...due)
      const last = await read($, warned)
      if (last !== 0 && last <= minutes) return

      await update($, warned, () => minutes)
      await notifyCacheExpiry($, Math.ceil(left / 60))
    })

    const home: Placement = (await $.store.get('placement')) === 'band' ? 'band' : 'pane'
    await update($, placement, () => home)
    if (home === 'pane') void $.ui.open({ id: PANE, title: TITLE })
    return result
  })

  on('command.run', { command: 'session_panel' }, async ($, e) => {
    // `/session_panel demo <minutes>` fakes the cache deadline to preview the warnings;
    // the next answer resets it.
    const demo = e.args.trim().match(/^demo\s+(\d+(?:\.\d+)?)$/)
    if (demo) {
      const seconds = Math.round(Number(demo[1]) * 60)
      const now = await $.clock.now()
      await update($, cache, () => ({ expiresAt: now + seconds * 1000, secondsLeft: seconds }))
      await update($, warned, () => 0)
      if ((await read($, placement)) === 'pane') await $.ui.open({ id: PANE, title: TITLE })

      return { text: `Cache demo: ${demo[1]} min left until the next answer resets it.` }
    }

    if (e.args.trim() === 'width') {
      const columns = lastColumns
      return { text: columns === null ? 'Stats not drawn yet.' : `Stats: ${columns} columns.` }
    }

    // `band` moves the stats above the prompt, freeing the side pane; `pane` moves them back.
    const target = e.args.trim()
    if (target === 'band' || target === 'pane') {
      await $.store.set('placement', target)
      await update($, placement, () => target)
      if (target === 'pane') {
        await $.ui.open({ id: PANE, title: TITLE })
        return { text: 'Session stats moved to the side pane.' }
      }
      await update($, isBandHidden, () => false)
      await $.ui.close({ id: PANE })
      return { text: 'Session stats moved above the prompt. `/session_panel pane` moves them back.' }
    }

    if ((await read($, placement)) === 'band') {
      const isHidden = !(await read($, isBandHidden))
      await update($, isBandHidden, () => isHidden)
      return { text: isHidden ? 'Session band hidden.' : 'Session band shown.' }
    }

    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (isOpen) {
      await $.ui.close({ id: PANE })
      return { text: 'Session pane hidden.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Session pane shown.' }
  })

  on('turn.start', async ($, e, next) => {
    const total = (await $.session.usage()).cost?.usd ?? 0
    await update($, stats, s => ({ ...s, turn: s.turn + 1, costAtStart: total, total }))
    await update($, isBusy, () => true)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    // Measured from the response's first item (its envelope, message_start), so
    // time-to-first-token is excluded but thinking that streams hidden or in one
    // late burst is still timed: output_tokens counts it.
    let startedAt: number | null = null

    for await (const chunk of next(e)) {
      if (startedAt === null) {
        startedAt = await $.clock.now()
      }

      if (chunk.kind === 'stop' && chunk.usage !== null) {
        const tokens = chunk.usage.output_tokens
        const seconds = ((await $.clock.now()) - startedAt) / 1000
        const speed = tokens / seconds
        if (tokens >= MIN_TOKENS && seconds >= MIN_SECONDS && speed <= MAX_SPEED) {
          await update($, stats, s => ({ ...s, speed: Math.round(speed) }))
        }
      }

      yield chunk
    }

    await refresh($)
  })

  // Pushed when a rate-limit window moves a whole point, so the bars move between turns too.
  on('session.measure', async ($, e, next) => {
    await update($, limits, () => e.rateLimits.map(toLimit))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refresh($)

    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, cache, () => ({ expiresAt: now + CACHE_TTL_MS, secondsLeft: CACHE_TTL_MS / 1000 }))
      await update($, isBusy, () => false)
      await update($, warned, () => 0)
    }

    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) =>
    drawStats($, $.ui.resolve(e), e.props.bodyColumns),
  )

  // In the band, under whatever the plugins beneath draw there. Claude Code's own
  // placeholder ({ type: 'engine' }) is never nested: the desktop drops a band that nests
  // it, which hid the stats whenever no turn was running.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    const isShown = (await read($, placement)) === 'band' && !(await read($, isBandHidden))
    if (!isShown || e.props.hasSurvey) return rest

    const ui = $.ui.resolve(e)
    const { Box } = ui
    const below = rest.type === 'engine' ? null : rest
    return (
      <Box flexDirection="column">
        {below}
        {await drawStats($, ui, e.props.bodyColumns)}
      </Box>
    )
  })
}
