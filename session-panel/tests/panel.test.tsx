import { describe, expect, mock, test } from 'claude-code/testing'
import type { CommandRunInput, On, RenderPropsOf, SessionStartInput } from 'claude-code'

const PANE = {
  component: 'Pane',
  requestId: 'session-panel',
  props: {
    title: 'Session',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

// Fri Oct 16 2026, 12:00 PM local time, so the labels read the same in any time zone.
const NOW = new Date(2026, 9, 16, 12, 0).getTime()
const HOUR = 60 * 60 * 1000
const ALERT = '#e0846b'

const BAND: { component: 'AbovePrompt'; props: RenderPropsOf['AbovePrompt'] } = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 10 }, view: {} },
}

const run = (args: string): CommandRunInput => ({
  command: 'session_panel',
  args,
  origin: { kind: 'composer' },
  presentation: { isFullscreen: false, columns: 120 },
})

const STATS = { turn: 3, speed: 80, turnCost: 0.4, total: 3.1, context: 34, costAtStart: 2.7 }
const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }

/**
 * The world beneath the mod for a session: its start and command, a store in a Map,
 * panes that open, and in the band either a plugin's line (cache-tax's) or Claude
 * Code's own placeholder, as the engine answers while no turn runs. Returns the store.
 */
function world(on: On, store = new Map<string, unknown>(), opened: string[] = [], beneath: 'line' | 'engine' = 'line') {
  seedState(on, { 'session-panel.stats': STATS })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('command.run', () => ({ text: '' }))
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => ({ value: undefined }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e) =>
    beneath === 'engine' ? { type: 'engine', ref: 0 } : $.ui.resolve(e).Text({ children: ['cache-tax · warm'] }),
  )
  return store
}

/** The color of the Text that shows exactly `text` (find matches a string anywhere in an element's text). */
async function colorOf(ui: { findAll: (q: { type: string; text: string }) => Promise<{ text: string; props: Record<string, unknown> }[]> }, text: string) {
  const found = (await ui.findAll({ type: 'Text', text })).find(t => t.text === text)
  expect(found).toBeDefined()
  return found?.props.color
}

/** Answers $.state reads for the given plugin/key pairs; everything else falls through to the kit's store. */
function seedState(on: On, values: Record<string, unknown>) {
  mock.clock(on, { now: NOW })
  on('state.get', async (_$, e, next) => {
    const key = `${e.plugin}.${e.key}`
    return key in values ? { value: { value: values[key], version: 1 } } : next(e)
  })
}

describe('session-panel', () => {
  test('leads with project time, then account usage', async ($, on) => {
    seedState(on, {
      'project-timer.summary': { project: 'myapp', total: '1h 00m', today: '10m', session: '5m' },
      'session-panel.limits': [
        { kind: 'five_hour', percentUsed: 23.5, resetsAt: null },
        { kind: 'seven_day', percentUsed: 92, resetsAt: null },
      ],
    })
    const ui = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: 'myapp 1h 00m 10m today' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '5h 23.5%' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Weekly 92%' })).toBeDefined()
    // Too early for a verdict: coloured by the share used, red from 90%.
    expect(await colorOf(ui, '92%')).toBe(ALERT)
    await ui.unmount()
  })

  test('says whether each window is on pace, red only when it runs out', async ($, on) => {
    seedState(on, {
      'session-panel.limits': [
        // 3 of 5 hours gone, 30% used: ~50% at reset.
        { kind: 'five_hour', percentUsed: 30, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
        // 4 of 7 days gone, 92% used: 100% at ~8:20 PM, days before the Monday reset.
        { kind: 'seven_day', percentUsed: 92, resetsAt: new Date(NOW + 3 * 24 * HOUR).toISOString() },
        // No known window: the row as before.
        { kind: 'spend_limit', percentUsed: 40, resetsAt: null },
      ],
    })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'session-panel', surface, ...PANE })
      expect(await ui.find({ type: 'Text', text: '5h 30%' })).toBeDefined()
      expect(await colorOf(ui, 'on track, ~50%')).toBeUndefined()

      expect(await ui.find({ type: 'Text', text: 'Weekly 92%' })).toBeDefined()
      expect(await colorOf(ui, 'runs out ~8:20 PM')).toBe(ALERT)
      // One line: the verdict says enough, so no reset times beside it.
      expect(await ui.find({ type: 'Text', text: /resets/ })).toBeUndefined()

      expect(await ui.find({ type: 'Text', text: 'Spend 40%' })).toBeDefined()

      // Bars on the desktop only.
      const bars = await ui.findAll({ type: 'Svg' })
      expect(bars).toHaveLength(surface === 'desktop' ? 3 : 0)
      // The even-pace mark on the windowed limits (60% and 4/7 of the way), none on the spend limit.
      const marks = bars.map(b => String(b.props.source).match(/<rect x="([\d.]+)" width="1.5"/)?.[1] ?? null)
      expect(marks).toEqual(surface === 'desktop' ? ['28.05', '26.68', null] : [])
      // Neutral fill on track, red where the week runs out.
      const fills = bars.map(b => String(b.props.source).match(/<rect width="\d+" height="4" rx="2" fill="(#\w+)"\/>/)?.[1])
      expect(fills).toEqual(surface === 'desktop' ? ['#8a8f8c', ALERT, '#8a8f8c'] : [])
      await ui.unmount()
    }
  })

  test('the pace moves with the clock between pushes', async ($, on) => {
    const clock = mock.clock(on, { now: NOW })
    on('state.get', async (_$, e, next) =>
      `${e.plugin}.${e.key}` === 'session-panel.limits'
        ? { value: { value: [{ kind: 'five_hour', percentUsed: 57, resetsAt: new Date(NOW + 2 * HOUR).toISOString() }], version: 1 } }
        : next(e),
    )
    const first = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', ...PANE })
    expect(await first.find({ type: 'Text', text: '5h 57%' })).toBeDefined()
    expect(await colorOf(first, 'tight, ~95%')).toBe('#e2a94e')
    await first.unmount()

    // An hour later with no new reading: 4 of 5 hours gone, ~71% at reset.
    await clock.advance(HOUR)
    const later = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', ...PANE })
    expect(await later.find({ type: 'Text', text: 'on track, ~71%' })).toBeDefined()
    await later.unmount()
  })

  test('shows neither section outside the project and off a subscription', async ($, on) => {
    seedState(on, {})
    const ui = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', ...PANE })
    expect(await ui.find({ type: 'Text', text: /myapp/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /5h|Weekly/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Stats appear after the first turn/ })).toBeDefined()
    await ui.unmount()
  })

  test('one line of segments that wraps as the room narrows', async ($, on) => {
    seedState(on, {
      'project-timer.summary': { project: 'myapp', total: '1h 00m', today: '10m', session: '5m' },
      'session-panel.limits': [{ kind: 'five_hour', percentUsed: 30, resetsAt: new Date(NOW + 2 * HOUR).toISOString() }],
      'session-panel.stats': STATS,
    })
    // Every segment, in order: project time, each limit, then this session.
    const SEGMENTS = ['myapp 1h 00m 10m today', '5h 30%', 'Turn 3', '⚡ 80 tok/s', '$0.40 turn', '$3.10 session', '⧗ - cache', '◔ 34% context']
    for (const bodyColumns of [120, 40] as const) {
      for (const surface of ['terminal', 'desktop'] as const) {
        const ui = await $.ui.mount({ plugin: 'session-panel', surface, ...PANE, props: { ...PANE.props, bodyColumns } })
        const row = await ui.find({ key: 'stats' })
        expect(row?.props.flexDirection).toBe('row')
        expect(row?.props.flexWrap).toBe('wrap')
        const drawn = await Promise.all(
          SEGMENTS.map(async text => ((await ui.find({ type: 'Text', text })) ? text : `missing ${text}`)),
        )
        expect(drawn).toEqual(SEGMENTS)
        // A limit is a box of its own: its text, the bar on the desktop, the verdict.
        expect(await ui.find({ key: 'seg-limit-five_hour' })).toBeDefined()
        // Colour marks warnings only: the turn cost is plain.
        expect(await colorOf(ui, '$0.40')).toBeUndefined()
        await ui.unmount()
      }
    }
  })

  test('the cache colours its own segment as it runs out', async ($, on) => {
    seedState(on, {
      'session-panel.stats': { ...STATS, context: 88 },
      'session-panel.cache': { expiresAt: NOW + 5 * 60 * 1000, secondsLeft: 5 * 60 },
    })
    const ui = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', ...PANE })
    expect(await colorOf(ui, '05:00')).toBe(ALERT)
    expect(await colorOf(ui, '88%')).toBe(ALERT)
    expect((await ui.find({ key: 'stats' }))?.props.borderStyle).toBeUndefined()
    await ui.unmount()
  })

  test('`band` moves the stats above the prompt, kept for the next session; `pane` moves them back', async ($, on) => {
    const store = world(on)
    await $.session.start(SESSION)
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ plugin: 'session-panel', surface, ...BAND })
      expect(await band.find({ key: 'stats' })).toBeUndefined()
      await band.unmount()
    }

    expect((await $.command.run(run('band'))).text).toMatch(/moved above the prompt/)
    expect(store.get('placement')).toBe('band')
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ plugin: 'session-panel', surface, ...BAND })
      expect(await band.find({ key: 'stats' })).toBeDefined()
      expect(await band.find({ type: 'Text', text: '◔ 34% context' })).toBeDefined()
      expect(await band.find({ type: 'Text', text: 'cache-tax · warm' })).toBeDefined()
      await band.unmount()
    }

    // A survey has the band to itself.
    const survey = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', ...BAND, props: { ...BAND.props, hasSurvey: true } })
    expect(await survey.find({ key: 'stats' })).toBeUndefined()
    await survey.unmount()

    // Bare, the command hides the band and shows it again.
    expect((await $.command.run(run(''))).text).toBe('Session band hidden.')
    const hidden = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', ...BAND })
    expect(await hidden.find({ key: 'stats' })).toBeUndefined()
    await hidden.unmount()
    expect((await $.command.run(run(''))).text).toBe('Session band shown.')

    expect((await $.command.run(run('pane'))).text).toBe('Session stats moved to the side pane.')
    expect(store.get('placement')).toBe('pane')
    const back = await $.ui.mount({ plugin: 'session-panel', surface: 'terminal', ...BAND })
    expect(await back.find({ key: 'stats' })).toBeUndefined()
    await back.unmount()
  })

  test('a session starts where the last one left the stats', async ($, on) => {
    const opened: string[] = []
    world(on, new Map([['placement', 'band']]), opened)
    await $.session.start(SESSION)
    expect(opened).toEqual([])
    const band = await $.ui.mount({ plugin: 'session-panel', surface: 'desktop', ...BAND })
    expect(await band.find({ key: 'stats' })).toBeDefined()
    await band.unmount()
  })

  test('with no turn running the band never nests Claude Code\'s own placeholder', async ($, on) => {
    // The desktop drops a band that nests { type: 'engine' }: the stats vanished while idle.
    world(on, new Map([['placement', 'band']]), [], 'engine')
    await $.session.start(SESSION)
    for (const surface of ['terminal', 'desktop'] as const) {
      const band = await $.ui.mount({ plugin: 'session-panel', surface, ...BAND })
      expect(await band.find({ key: 'stats' })).toBeDefined()
      expect(await band.find({ type: 'engine' })).toBeUndefined()
      await band.unmount()
    }
  })
})
