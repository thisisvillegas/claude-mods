import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const SUMMARY = {
  project: 'myapp',
  root: '/dev/myapp',
  totalMs: 3_600_000,
  todayMs: 600_000,
  sessionMs: 300_000,
  total: '1h 00m',
  today: '10m',
  session: '5m',
  sessions: 2,
  days: [
    { date: '2026-10-15', ms: 3_000_000, label: '50m' },
    { date: '2026-10-16', ms: 600_000, label: '10m' },
  ],
  label: '1h 00m total · 10m today',
}

const ALL = [
  { project: 'myapp', root: '/dev/myapp', slug: '-dev-myapp', totalMs: 3_600_000, todayMs: 600_000, lastActivityMs: 2, total: '1h 00m', today: '10m', lastActivity: '2026-10-16 13:55', sessions: 2 },
  { project: 'notes', root: '/dev/notes', slug: '-dev-notes', totalMs: 120_000, todayMs: 0, lastActivityMs: 1, total: '2m', today: '0m', lastActivity: '2026-10-01 09:05', sessions: 1 },
  { project: 'empty', root: 'empty', slug: 'empty', totalMs: 0, todayMs: 0, lastActivityMs: null, total: '0m', today: '0m', lastActivity: null, sessions: 0 },
]

/** Stands in for the engine. Records the script calls and the summaries the mod publishes. */
function engine(on: On, stdout: string = JSON.stringify(SUMMARY), allStdout: string = JSON.stringify(ALL)) {
  const runs: (readonly string[])[] = []
  const published: unknown[] = []
  mock.clock(on)
  on('state.set', async (_$, e, next) => {
    if (e.plugin === 'project-timer' && e.key === 'summary') published.push(e.value)
    return next(e)
  })
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'session-1' }))
  on('session.cwd', async () => ({ value: '/dev/myapp/server' }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('process.run', async (_$, e) => {
    runs.push(e.argv)
    const out = e.argv.includes('--all') ? allStdout : stdout
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return { runs, published }
}

describe('project-timer', () => {
  test('runs its own script for the session folder and publishes the summary', async ($, on) => {
    const { runs, published } = engine(on)
    await $.session.start({ cwd: '/dev/myapp/server', surface: 'desktop', isInteractive: true })
    expect(runs[0]?.slice(1)).toEqual([
      expect.stringMatching(/scripts\/timelog\.mjs$/),
      '--cwd',
      '/dev/myapp/server',
      '--session',
      'session-1',
      '--json',
    ])
    expect(published).toEqual([SUMMARY])
  })

  test('publishes null outside a Claude Code project', async ($, on) => {
    const { published } = engine(on, 'null')
    await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true })
    expect(published).toEqual([null])
  })

  test('the command shows project, session and days newest first', async ($, on) => {
    engine(on)
    await $.session.start({ cwd: '/dev/myapp', surface: 'desktop', isInteractive: true })
    const out = await $.command.run({
      command: 'project-time',
      args: '',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
    expect(out.text).toBe(
      'myapp: 1h 00m total · 10m today · this session 5m\n  2026-10-16  10m\n  2026-10-15  50m',
    )
  })

  test('`all` lists every project, most recent first, without touching the session summary', async ($, on) => {
    const { runs, published } = engine(on)
    await $.session.start({ cwd: '/dev/myapp', surface: 'desktop', isInteractive: true })
    const out = await $.command.run({
      command: 'project-time',
      args: ' all ',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
    expect(runs.at(-1)?.slice(1)).toEqual([expect.stringMatching(/scripts\/timelog\.mjs$/), '--all', '--json'])
    expect(out.text).toBe(
      [
        'myapp  1h 00m total · 10m today · last 2026-10-16 13:55',
        'notes  2m total · 0m today · last 2026-10-01 09:05',
        'empty  0m total · 0m today · last never',
      ].join('\n'),
    )
    expect(published).toEqual([SUMMARY])
  })

  test('`all` with no projects says so', async ($, on) => {
    engine(on, JSON.stringify(SUMMARY), '[]')
    await $.session.start({ cwd: '/dev/myapp', surface: 'desktop', isInteractive: true })
    const out = await $.command.run({
      command: 'project-time',
      args: 'all',
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 80 },
    })
    expect(out.text).toBe('No Claude Code projects found.')
  })
})
