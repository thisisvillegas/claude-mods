# claude-mods

Personal Claude Code mods, published as the `dres-mods` marketplace.

- `session-panel`: project and session time (from the project-timer mod), Claude 5-hour and weekly limits, turn speed, cost, prompt cache countdown and context, as one line that wraps to the room. Lives in a side pane, or in the band above the prompt after `/session_panel band`. Local fork of johnnyvizz's session-band (MIT).
- `project-timer`: active time per project and session from the transcripts (`/project-time`). Sessions in a Claude Code worktree (`<project>/.claude/worktrees/<name>`) count toward the main project; overlapping sessions are never double counted. Tests: `node --test scripts/timelog.test.mjs`.

## Install

At the prompt of a terminal session (answer `y` to add the marketplace, then pick a scope):

```
/plugin install session-panel --marketplace thisisvillegas/claude-mods
/plugin install project-timer --marketplace thisisvillegas/claude-mods
```

From a shell:

```bash
claude plugin install session-panel --marketplace thisisvillegas/claude-mods
claude plugin install project-timer --marketplace thisisvillegas/claude-mods
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `thisisvillegas/claude-mods`, then Add plugin.

The mods need Claude Code 2.1.287 or newer (`claude update`). Then run `/session_panel band` to put the stats above the prompt.

## Working on them

Edit a mod here, bump its version in `.claude-plugin/plugin.json`, then run `claude plugin marketplace update dres-mods`, `claude plugin update <mod>@dres-mods` and `/reload-plugins`.
