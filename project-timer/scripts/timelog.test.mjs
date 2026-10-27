// Tests for timelog.mjs: run with `node --test scripts/timelog.test.mjs`.
// Each test builds a throwaway HOME holding fake ~/.claude/projects transcripts and runs the
// script against it, so the real ~/.claude is never touched.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

const SCRIPT = path.join(path.dirname(new URL(import.meta.url).pathname), 'timelog.mjs');
const slugOf = (dir) => dir.replace(/[^A-Za-z0-9]/g, '-');
const T0 = Date.parse('2026-01-05T10:00:00Z');
const MIN = 60_000;

let home;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'project-timer-test-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const projectsDir = () => path.join(home, '.claude', 'projects');
const storeDir = () => path.join(home, '.claude', 'project-timer');
const storeFile = (root) => path.join(storeDir(), `${slugOf(root)}.json`);
const readStore = (root) => JSON.parse(fs.readFileSync(storeFile(root), 'utf8'));

/** Writes a transcript for `session` launched in `root`, one event per minute offset given. */
function transcript(root, session, minutes, { slug = slugOf(root), cwds = [] } = {}) {
  const dir = path.join(projectsDir(), slug);
  fs.mkdirSync(dir, { recursive: true });
  const lines = minutes.map((m, i) =>
    JSON.stringify({ type: 'user', cwd: cwds[i] ?? root, sessionId: session, timestamp: new Date(T0 + m * MIN).toISOString() }),
  );
  const file = path.join(dir, `${session}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function run(...args) {
  const out = spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  return { json: args.includes('--json') ? JSON.parse(out.stdout) : null, stdout: out.stdout, stderr: out.stderr };
}

test('names the project by the session transcript even when cwd is elsewhere', () => {
  const proj = path.join(home, 'dev', 'myapp');
  fs.mkdirSync(path.join(projectsDir(), slugOf(home)), { recursive: true }); // the home folder's own project
  transcript(proj, 's1', [0, 1, 2, 3], { cwds: [proj, proj, path.join(home, 'Downloads', 'myapp_export')] });
  const { json } = run('--cwd', path.join(home, 'Downloads', 'myapp_export'), '--session', 's1', '--json');
  assert.equal(json.project, 'myapp');
  assert.equal(json.root, proj);
  assert.equal(json.sessionMs, 3 * MIN);
  assert.equal(json.session, '3m');
});

test('the cwd fallback never matches an ancestor home folder', () => {
  fs.mkdirSync(path.join(projectsDir(), slugOf(home)), { recursive: true });
  const { json } = run('--cwd', path.join(home, 'Downloads', 'elsewhere'), '--session', 'unknown', '--json');
  assert.equal(json, null);
  assert.ok(!fs.existsSync(storeFile(home)), 'no store written for the home folder');
});

test('merge-only: a deleted transcript keeps its stored time', () => {
  const proj = path.join(home, 'dev', 'app');
  transcript(proj, 'a', [0, 5, 10]);
  const file = transcript(proj, 'b', [100, 102]);
  const before = run('--cwd', proj, '--json').json;
  assert.equal(before.totalMs, 12 * MIN);
  fs.unlinkSync(file);
  const after = run('--cwd', proj, '--json').json;
  assert.equal(after.totalMs, before.totalMs);
  assert.equal(after.sessions, 2);
  assert.deepEqual(readStore(proj).sessions.b.intervals, [[T0 + 100 * MIN, T0 + 102 * MIN]]);
});

test('union: recomputing from a transcript never shrinks stored time', () => {
  const proj = path.join(home, 'dev', 'app');
  transcript(proj, 'a', [0, 5]);
  fs.mkdirSync(storeDir(), { recursive: true });
  const older = [T0 - 60 * MIN, T0 - 50 * MIN]; // stored, no longer in the transcript
  const overlap = [T0 + 3 * MIN, T0 + 8 * MIN]; // stored, extends past the transcript's end
  fs.writeFileSync(storeFile(proj), JSON.stringify({ project: proj, idleMinutes: 10, sessions: { a: { intervals: [older, overlap] } } }));
  const { json } = run('--cwd', proj, '--json');
  assert.deepEqual(readStore(proj).sessions.a.intervals, [older, [T0, T0 + 8 * MIN]]);
  assert.equal(json.totalMs, 10 * MIN + 8 * MIN);
});

test('a corrupt store is moved aside, not overwritten', () => {
  const proj = path.join(home, 'dev', 'app');
  transcript(proj, 'a', [0, 4]);
  fs.mkdirSync(storeDir(), { recursive: true });
  fs.writeFileSync(storeFile(proj), '{ not json');
  fs.writeFileSync(`${storeFile(proj)}.bak`, '{"sessions":{}}\n');
  const { json, stderr } = run('--cwd', proj, '--json');
  assert.equal(json.totalMs, 4 * MIN);
  const aside = fs.readdirSync(storeDir()).filter((f) => /^.+\.corrupt-.+\.json$/.test(f));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(storeDir(), aside[0]), 'utf8'), '{ not json');
  assert.equal(fs.readFileSync(path.join(storeDir(), `${aside[0]}.bak`), 'utf8'), '{"sessions":{}}\n', 'last good .bak copied beside it');
  assert.match(stderr, /could not be parsed/);
  assert.ok(readStore(proj).sessions.a, 'a fresh store was started');
});

test('the previous store version is kept as .bak, and writes leave no temp files', () => {
  const proj = path.join(home, 'dev', 'app');
  transcript(proj, 'a', [0, 4]);
  run('--cwd', proj, '--json');
  const first = fs.readFileSync(storeFile(proj), 'utf8');
  assert.ok(!fs.existsSync(`${storeFile(proj)}.bak`), 'no .bak before there is a previous version');
  run('--cwd', proj, '--json'); // unchanged: no rewrite
  assert.ok(!fs.existsSync(`${storeFile(proj)}.bak`));
  transcript(proj, 'a', [0, 4, 8]);
  run('--cwd', proj, '--json');
  assert.equal(fs.readFileSync(`${storeFile(proj)}.bak`, 'utf8'), first);
  assert.notEqual(fs.readFileSync(storeFile(proj), 'utf8'), first);
  assert.deepEqual(fs.readdirSync(storeDir()).filter((f) => f.endsWith('.tmp')), []);
});

test('--all updates and lists every project, most recent first', () => {
  const a = path.join(home, 'dev', 'alpha');
  const b = path.join(home, 'dev', 'beta');
  const gone = path.join(home, 'dev', 'gone');
  transcript(a, 'a1', [0, 5]);
  transcript(b, 'b1', [200, 203]);
  fs.mkdirSync(path.join(projectsDir(), 'no-transcripts'), { recursive: true });
  fs.mkdirSync(storeDir(), { recursive: true });
  // A project whose transcripts folder is gone: only its store remains.
  fs.writeFileSync(storeFile(gone), JSON.stringify({ project: gone, idleMinutes: 10, sessions: { g: { intervals: [[T0 - 10 * MIN, T0 - 9 * MIN]] } } }));


  const { json } = run('--all', '--json');
  assert.deepEqual(
    json.map((p) => [p.project, p.total]),
    [
      ['beta', '3m'],
      ['alpha', '5m'],
      ['gone', '1m'],
      ['no-transcripts', '0m'],
    ],
  );
  assert.equal(json[0].root, b);
  assert.equal(json[3].lastActivity, null);
  assert.ok(fs.existsSync(storeFile(a)) && fs.existsSync(storeFile(b)), 'stores written for every project');
  assert.ok(JSON.parse(fs.readFileSync(storeFile(gone), 'utf8')).sessions.g, 'orphan store kept');

  const text = run('--all').stdout.trim().split('\n');
  assert.equal(text.length, 4);
  assert.match(text[0], /^beta\s+3m total · 0m today · last \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.match(text[3], /^no-transcripts\s+0m total · 0m today · last never$/);
});

test('a worktree session adds to its main project, from either folder, with no double counting', () => {
  const main = path.join(home, 'dev', 'myapp');
  const tree = path.join(main, '.claude', 'worktrees', 'feature-x');
  transcript(main, 'm1', [0, 5]);
  transcript(tree, 'w1', [3, 8, 100, 103]); // 3..8 overlaps the main session's 0..5

  const fromTree = run('--cwd', tree, '--session', 'w1', '--json').json;
  assert.equal(fromTree.project, 'myapp');
  assert.equal(fromTree.root, main);
  assert.equal(fromTree.totalMs, 8 * MIN + 3 * MIN);
  assert.equal(fromTree.sessionMs, 8 * MIN);
  assert.equal(fromTree.sessions, 2);

  const fromMain = run('--cwd', main, '--session', 'm1', '--json').json;
  assert.equal(fromMain.totalMs, fromTree.totalMs);
  assert.equal(fromMain.sessionMs, 5 * MIN);
  // Each folder keeps its own merge-only store.
  assert.deepEqual(Object.keys(readStore(main).sessions), ['m1']);
  assert.deepEqual(Object.keys(readStore(tree).sessions), ['w1']);
});

test('a worktree whose transcripts are gone still counts from its store; a look-alike slug does not', () => {
  const main = path.join(home, 'dev', 'app');
  const tree = path.join(main, '.claude', 'worktrees', 'old');
  transcript(main, 'm1', [0, 4]);
  fs.mkdirSync(storeDir(), { recursive: true });
  fs.writeFileSync(storeFile(tree), JSON.stringify({ project: tree, idleMinutes: 10, sessions: { w: { intervals: [[T0 - 10 * MIN, T0 - 8 * MIN]] } } }));
  // Same slug prefix, but its store says it belongs elsewhere.
  const impostor = `${slugOf(main)}--claude-worktrees-x`;
  fs.writeFileSync(path.join(storeDir(), `${impostor}.json`), JSON.stringify({ project: path.join(home, 'other'), idleMinutes: 10, sessions: { i: { intervals: [[T0 - 30 * MIN, T0 - 20 * MIN]] } } }));
  const { json } = run('--cwd', main, '--json');
  assert.equal(json.totalMs, 4 * MIN + 2 * MIN);
});

test('--all lists a worktree under its main project, not as its own line', () => {
  const main = path.join(home, 'dev', 'myapp');
  const tree = path.join(main, '.claude', 'worktrees', 'feature');
  const other = path.join(home, 'dev', 'other');
  transcript(main, 'm1', [0, 5]);
  transcript(tree, 'w1', [100, 104]);
  transcript(other, 'o1', [200, 201]);
  const { json } = run('--all', '--json');
  assert.deepEqual(
    json.map((p) => [p.project, p.total, p.sessions]),
    [
      ['other', '1m', 1],
      ['myapp', '9m', 2],
    ],
  );
  assert.equal(json[1].root, main);
});
