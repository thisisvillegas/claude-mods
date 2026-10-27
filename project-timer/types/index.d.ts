/** What `node scripts/timelog.mjs --json` prints for a project. Labels are pre-formatted. */
export type TimeSummary = {
  /** Folder name of the project root, e.g. `myapp`. */
  project: string;
  root: string;
  totalMs: number;
  todayMs: number;
  /** This session's active time; null when its transcript has no activity yet. */
  sessionMs: number | null;
  total: string;
  today: string;
  session: string | null;
  sessions: number;
  days: { date: string; ms: number; label: string }[];
  label: string;
};

/** One entry of what `node scripts/timelog.mjs --all --json` prints, most recently active first. */
export type ProjectTime = {
  /** Folder name of the project root (from its transcripts' first `cwd`), or the slug. */
  project: string;
  root: string;
  /** Folder name under ~/.claude/projects and ~/.claude/project-timer. */
  slug: string;
  totalMs: number;
  todayMs: number;
  /** End of the latest active interval; null when the project has none. */
  lastActivityMs: number | null;
  total: string;
  today: string;
  /** `YYYY-MM-DD HH:MM`, machine time zone; null when the project has no activity. */
  lastActivity: string | null;
  sessions: number;
};

declare module 'claude-code' {
  interface PluginState {
    'project-timer': { summary: TimeSummary | null };
  }
}
