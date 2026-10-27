#!/usr/bin/env node
// Time spent per Claude Code project, from session transcripts. Used by the project-timer mod.
//
// Every transcript line carries a timestamp. Two consecutive events less than IDLE_MINUTES
// apart count as active time; a longer gap is a break. Overlapping sessions are merged so
// parallel sessions are not double counted. Work outside Claude Code is not seen.
//
// Claude Code deletes transcripts after 30 days, so every run snapshots each session's active
// intervals to ~/.claude/project-timer/<project-slug>.json, which keeps the history. Each store
// file is that project's timer and is never deleted or truncated:
//   - writes are merge-only: stored sessions stay even when their transcripts are gone, and a
//     session's stored intervals are only ever widened (union with the recomputed ones);
//   - writes are atomic (temp file in the same folder, then rename), and the previous version
//     is kept as <slug>.json.bak;
//   - a store that cannot be parsed is moved aside to <slug>.corrupt-<timestamp>.json (never
//     overwritten) and that project starts a fresh store.
//
//   node timelog.mjs --cwd <dir> [--session <id>] [--json]
//   node timelog.mjs --all [--json]
//
// The project is the one whose transcripts folder holds --session's transcript; without a
// session, the nearest project folder at or above --cwd (never an ancestor home folder).
// A worktree Claude Code made inside a project (<root>/.claude/worktrees/<name>) counts as
// that project: its sessions add to the main checkout's time (each folder keeps its own store).
// Prints `null` (with --json) when there is none. --all updates every project under
// ~/.claude/projects (plus stores whose transcripts folder is gone) and lists them, most
// recently active first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const IDLE_MINUTES = 10;
const IDLE_MS = IDLE_MINUTES * 60_000;

const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const asJson = argv.includes('--json');
const allProjects = argv.includes('--all');
const cwd = path.resolve(option('--cwd') ?? process.cwd());
const sessionId = option('--session');

const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
const storeRoot = path.join(os.homedir(), '.claude', 'project-timer');
const slugOf = (dir) => dir.replace(/[^A-Za-z0-9]/g, '-');
const storeFileOf = (slug) => path.join(storeRoot, `${slug}.json`);
const firstCwd = (text) => /"cwd":"([^"]+)"/.exec(text)?.[1] ?? null;
const WORKTREES = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
/** A worktree's main checkout: '/dev/app/.claude/worktrees/x' -> '/dev/app'; any other folder unchanged. */
const mainRootOf = (dir) => {
  const i = dir.indexOf(WORKTREES);
  return i > 0 ? dir.slice(0, i) : dir;
};
const log = (message) => console.error(`project-timer: ${message}`);

/**
 * The project a session belongs to: the folder that holds its transcript, named by the first
 * `cwd` the transcript recorded (where the session was launched). This is stable even when the
 * session later works in other folders.
 */
function findSessionProject(id) {
  if (!id || !fs.existsSync(projectsRoot)) return null;
  for (const slug of fs.readdirSync(projectsRoot)) {
    const file = path.join(projectsRoot, slug, `${id}.jsonl`);
    if (!fs.existsSync(file)) continue;
    return { slug, root: firstCwd(fs.readFileSync(file, 'utf8')) ?? slug };
  }
  return null;
}

/** Fallback without a session: the nearest project folder at or above `start`, never an ancestor home folder. */
function findProject(start) {
  const home = os.homedir();
  let dir = start;
  for (;;) {
    if (dir === home && start !== home) return null;
    if (fs.existsSync(path.join(projectsRoot, slugOf(dir)))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Active [start, end] intervals (ms) from one transcript's text. */
function intervalsFromText(text) {
  const times = [...text.matchAll(/"timestamp":"([^"]+)"/g)]
    .map((m) => Date.parse(m[1]))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const intervals = [];
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] <= IDLE_MS) intervals.push([times[i - 1], times[i]]);
  }
  return merge(intervals);
}

/** Union of intervals, sorted and with overlaps joined. Never mutates its input. */
function merge(intervals) {
  const out = [];
  for (const [start, end] of [...intervals].sort((a, b) => a[0] - b[0])) {
    const last = out.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

const sum = (intervals) => intervals.reduce((total, [s, e]) => total + (e - s), 0);
const localDay = (ms) => new Date(ms).toLocaleDateString('en-CA'); // YYYY-MM-DD, machine time zone
const localMinute = (ms) => {
  const d = new Date(ms);
  return `${localDay(ms)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

function nextLocalMidnight(ms) {
  const d = new Date(ms);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function byDay(intervals) {
  const days = new Map();
  for (let [start, end] of intervals) {
    while (start < end) {
      const cut = Math.min(end, nextLocalMidnight(start));
      days.set(localDay(start), (days.get(localDay(start)) ?? 0) + (cut - start));
      start = cut;
    }
  }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, ms]) => ({ date, ms }));
}

export function formatDuration(ms) {
  const minutes = Math.round(ms / 60_000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

// ---------------------------------------------------------------------------------------------
// Store: one file per project, merge-only, atomic writes.

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInterval = (v) => Array.isArray(v) && v.length === 2 && v.every(Number.isFinite) && v[0] <= v[1];

/** A store we can merge into without dropping anything: every session holds valid intervals. */
function isValidStore(store) {
  if (!isPlainObject(store)) return false;
  if (store.sessions === undefined) return true;
  if (!isPlainObject(store.sessions)) return false;
  return Object.values(store.sessions).every((s) => isPlainObject(s) && Array.isArray(s.intervals) && s.intervals.every(isInterval));
}

/** A path under storeRoot that does not exist yet, for moving a file aside. */
function freePath(base, ext) {
  let candidate = `${base}${ext}`;
  for (let n = 1; fs.existsSync(candidate); n++) candidate = `${base}-${n}${ext}`;
  return candidate;
}

/**
 * Reads a project's store. A missing file is a fresh store. A file that cannot be parsed is
 * moved aside (never overwritten) and the project starts fresh; if it cannot be moved, the
 * store is reported as not writable so this run leaves it alone.
 */
function readStore(slug) {
  const file = storeFileOf(slug);
  const fresh = { sessions: {} };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { store: fresh, writable: true };
    log(`cannot read ${file} (${error.code ?? error.message}); leaving it untouched this run`);
    return { store: fresh, writable: false };
  }
  try {
    const store = JSON.parse(text);
    if (isValidStore(store)) return { store: { ...store, sessions: store.sessions ?? {} }, writable: true };
  } catch {
    // fall through: corrupt
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const aside = freePath(path.join(storeRoot, `${slug}.corrupt-${stamp}`), '.json');
  try {
    fs.renameSync(file, aside);
  } catch (error) {
    log(`${file} is corrupt and could not be moved aside (${error.code ?? error.message}); leaving it untouched this run`);
    return { store: fresh, writable: false };
  }
  // The .bak holds the last good version; the next write replaces it, so keep a copy beside
  // the corrupt file first (a copy, the .bak itself stays where it is).
  const bak = `${file}.bak`;
  if (fs.existsSync(bak)) {
    try {
      fs.copyFileSync(bak, `${aside}.bak`, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      log(`could not copy ${bak} beside ${aside} (${error.code ?? error.message})`);
    }
  }
  log(`${file} could not be parsed; moved it to ${aside} and started a fresh store for this project`);
  return { store: fresh, writable: true };
}

/** Writes `content` to `file` via a temp file in the same folder and a rename. */
function writeAtomic(file, content) {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(temp, 'wx');
  try {
    fs.writeSync(fd, content);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}

/** Replaces the store file with `content` when it differs, keeping the previous version as .bak. */
function writeStore(slug, content) {
  fs.mkdirSync(storeRoot, { recursive: true });
  const file = storeFileOf(slug);
  let current = null;
  try {
    current = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (current === content) return;
  if (current !== null) writeAtomic(`${file}.bak`, current);
  writeAtomic(file, content);
}

/** Session maps unioned: every session of either side, each session's intervals unioned. */
function unionSessions(a, b) {
  const out = { ...a };
  for (const [id, session] of Object.entries(b)) {
    out[id] = out[id] ? { ...out[id], ...session, intervals: merge([...out[id].intervals, ...session.intervals]) } : session;
  }
  return out;
}

/** Transcripts of a project: session id -> { intervals, cwd }. Empty when the folder is gone. */
function readTranscripts(slug) {
  const dir = path.join(projectsRoot, slug);
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return new Map();
  }
  const out = new Map();
  for (const file of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue; // vanished or unreadable: whatever was stored for it stays
    }
    out.set(path.basename(file, '.jsonl'), { intervals: intervalsFromText(text), cwd: firstCwd(text) });
  }
  return out;
}

/**
 * Brings one project's store up to date (merge-only) and returns its sessions and root.
 * `root` names the project; without one it comes from the transcripts' first `cwd`.
 */
function updateProject(slug, root) {
  const transcripts = readTranscripts(slug);
  const { store, writable } = readStore(slug);

  const recomputed = {};
  for (const [id, t] of transcripts) if (t.intervals.length) recomputed[id] = { intervals: t.intervals };
  let sessions = unionSessions(store.sessions, recomputed);

  if (!root) {
    const cwds = [...transcripts.values()].map((t) => t.cwd).filter(Boolean);
    root = cwds.find((c) => slugOf(c) === slug) ?? (typeof store.project === 'string' ? store.project : null) ?? cwds[0] ?? slug;
  }

  if (writable) {
    // Another session may have written since we read: fold in whatever it has too.
    const latest = readStore(slug);
    if (latest.writable) {
      sessions = unionSessions(latest.store.sessions, sessions);
      const sorted = Object.fromEntries(Object.entries(sessions).sort(([a], [b]) => a.localeCompare(b)));
      // Same key order as before (project, idleMinutes, sessions); any other keys are kept.
      const { project: _project, idleMinutes: _idle, sessions: _sessions, ...rest } = latest.store;
      writeStore(slug, `${JSON.stringify({ project: root, idleMinutes: IDLE_MINUTES, ...rest, sessions: sorted }, null, 2)}\n`);
      sessions = sorted;
    }
  }
  return { root, sessions };
}

function totals(sessions) {
  const all = merge(Object.values(sessions).flatMap((s) => s.intervals));
  const days = byDay(all);
  const totalMs = sum(all);
  const todayMs = days.find((d) => d.date === localDay(Date.now()))?.ms ?? 0;
  const lastActivityMs = all.length ? all.at(-1)[1] : null;
  return { days, totalMs, todayMs, lastActivityMs };
}

// ---------------------------------------------------------------------------------------------

/** Slugs of transcript folders and stores that may be worktrees of the project `mainSlug`. */
function worktreeSlugsOf(mainSlug) {
  const prefix = `${mainSlug}${slugOf(WORKTREES)}`;
  const slugs = new Set();
  try {
    for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) slugs.add(entry.name);
    }
  } catch {
    // no projects folder
  }
  try {
    for (const f of fs.readdirSync(storeRoot)) {
      if (f.startsWith(prefix) && f.endsWith('.json') && !/\.corrupt-[^/]*\.json$/.test(f)) slugs.add(f.slice(0, -'.json'.length));
    }
  } catch {
    // no stores yet
  }
  return [...slugs];
}

function runProject() {
  const session = findSessionProject(sessionId);
  const found = session?.root ?? findProject(cwd);
  if (!found) return null;
  const root = mainRootOf(found);
  const slug = found === root ? (session?.slug ?? slugOf(root)) : slugOf(root);
  let { sessions } = updateProject(slug, root);
  // Worktrees of this project: their sessions add to its time (a slug prefix alone is not proof; their root must match).
  for (const worktreeSlug of worktreeSlugsOf(slug)) {
    const worktree = updateProject(worktreeSlug, null);
    if (mainRootOf(worktree.root) === root) sessions = unionSessions(sessions, worktree.sessions);
  }

  const { days, totalMs, todayMs } = totals(sessions);
  const sessionMs = sessionId && sessions[sessionId] ? sum(sessions[sessionId].intervals) : null;
  return {
    project: path.basename(root),
    root,
    totalMs,
    todayMs,
    sessionMs,
    total: formatDuration(totalMs),
    today: formatDuration(todayMs),
    session: sessionMs === null ? null : formatDuration(sessionMs),
    sessions: Object.keys(sessions).length,
    days: days.map((d) => ({ ...d, label: formatDuration(d.ms) })),
    label: `${formatDuration(totalMs)} total · ${formatDuration(todayMs)} today`,
  };
}

/** Every project with transcripts or a store, most recently active first. */
function runAll() {
  const slugs = new Set();
  try {
    for (const entry of fs.readdirSync(projectsRoot, { withFileTypes: true })) if (entry.isDirectory()) slugs.add(entry.name);
  } catch {
    // no projects folder
  }
  try {
    for (const f of fs.readdirSync(storeRoot)) {
      // <slug>.json only: not .bak, .corrupt-*, or temp files
      if (f.endsWith('.json') && !f.startsWith('.') && !/\.corrupt-[^/]*\.json$/.test(f)) slugs.add(f.slice(0, -'.json'.length));
    }
  } catch {
    // no stores yet
  }

  // Worktrees are folded into their main project.
  const projects = new Map();
  for (const slug of slugs) {
    const { root, sessions } = updateProject(slug, null);
    const main = mainRootOf(root);
    const key = main === root ? slug : slugOf(main);
    const project = projects.get(key);
    if (project) project.sessions = unionSessions(project.sessions, sessions);
    else projects.set(key, { root: main, sessions });
  }

  const list = [];
  for (const [slug, { root, sessions }] of projects) {
    const { totalMs, todayMs, lastActivityMs } = totals(sessions);
    list.push({
      project: root === slug ? slug : path.basename(root),
      root,
      slug,
      totalMs,
      todayMs,
      lastActivityMs,
      total: formatDuration(totalMs),
      today: formatDuration(todayMs),
      lastActivity: lastActivityMs === null ? null : localMinute(lastActivityMs),
      sessions: Object.keys(sessions).length,
    });
  }
  return list.sort((a, b) => (b.lastActivityMs ?? -Infinity) - (a.lastActivityMs ?? -Infinity) || a.project.localeCompare(b.project));
}

if (allProjects) {
  const list = runAll();
  if (asJson) console.log(JSON.stringify(list));
  else if (!list.length) console.log('No Claude Code projects found.');
  else {
    const width = Math.max(...list.map((p) => p.project.length));
    for (const p of list) {
      console.log(`${p.project.padEnd(width)}  ${p.total} total · ${p.today} today · last ${p.lastActivity ?? 'never'}`);
    }
  }
} else {
  const summary = runProject();
  if (asJson) console.log(JSON.stringify(summary));
  else if (!summary) console.log(`No Claude Code project found at or above ${cwd}`);
  else {
    console.log(`${summary.project}: ${summary.label}${summary.session ? ` · this session ${summary.session}` : ''}`);
    for (const d of summary.days.slice(-7)) console.log(`  ${d.date}  ${d.label}`);
  }
}
