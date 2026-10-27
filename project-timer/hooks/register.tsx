// Tracks time spent in the current Claude Code project and session, for any project on the
// machine, and publishes it in $.state for the Session pane (session-panel) to draw.
// The counting lives in scripts/timelog.mjs next to this module; this mod only runs it.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ProjectTime, TimeSummary } from '../types'

const SCRIPT = 'scripts/timelog.mjs'
const REFRESH_MS = 60_000
// --all reads every transcript on the machine.
const ALL_TIMEOUT_MS = 60_000
const DAYS_SHOWN = 14
// The host's PATH may not include Homebrew's node; try the usual spots in order.
const NODE_CANDIDATES = ['node', '/opt/homebrew/opt/node@24/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node']

const summary = atom({ plugin: 'project-timer', key: 'summary' } as const, null)

/** A node binary that worked; reset on every reload. */
const found: { node?: string } = {}

/** Runs the script with `args` and parses its JSON; undefined when no node binary ran it. */
async function runScript<T>($: EngineInterface, args: string[], timeoutMs: number): Promise<{ data: T } | undefined> {
  const argv = [`${$.plugin.root}/${SCRIPT}`, ...args, '--json']
  for (const node of found.node ? [found.node] : NODE_CANDIDATES) {
    try {
      const ran = await $.process.run([node, ...argv], { timeoutMs })
      if (ran.exitCode !== 0) continue
      const data = JSON.parse(ran.stdout) as T
      found.node = node
      return { data }
    } catch {
      // not found or bad output: try the next candidate
    }
  }
  return undefined
}

async function refresh($: EngineInterface, cwd?: string): Promise<TimeSummary | null> {
  const dir = cwd ?? (await $.session.cwd())
  const ran = await runScript<TimeSummary | null>($, ['--cwd', dir, '--session', await $.session.id()], 20_000)
  if (!ran) return null
  await update($, summary, () => ran.data)
  return ran.data
}

/** `/project-time all`: every project on the machine, most recently active first. */
async function allProjects($: EngineInterface): Promise<string> {
  const ran = await runScript<ProjectTime[]>($, ['--all'], ALL_TIMEOUT_MS)
  if (!ran) return 'No time data: node was not found.'
  const list = ran.data
  if (!list.length) return 'No Claude Code projects found.'
  const width = Math.max(...list.map(p => p.project.length))
  return list
    .map(p => `${p.project.padEnd(width)}  ${p.total} total · ${p.today} today · last ${p.lastActivity ?? 'never'}`)
    .join('\n')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'project-time',
      description: 'Time spent in this project, by day; `all` lists every project',
      argumentHint: '[all]',
    })
    await refresh($, e.cwd)
    $.clock.every(REFRESH_MS, () => void refresh($))
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await refresh($)
    return done
  })

  on('command.run', { command: 'project-time' }, async ($, e) => {
    if (e.args.trim() === 'all') return { text: await allProjects($) }
    const data = (await refresh($)) ?? (await read($, summary))
    if (!data) return { text: 'No time data: this folder is not a Claude Code project yet, or node was not found.' }
    const session = data.session ? ` · this session ${data.session}` : ''
    const days = [...data.days].reverse().slice(0, DAYS_SHOWN).map(d => `  ${d.date}  ${d.label}`)
    return { text: [`${data.project}: ${data.label}${session}`, ...days].join('\n') }
  })
}
