# session-panel

Local fork of [johnnyvizz's session-band](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/session-band) (MIT).
Same stats (turn, output speed, turn and session cost, prompt cache countdown, context fill) and the
same cache-expiry notification, plus project time and the Claude 5-hour and weekly limits.

The stats are one line of short segments (project time, each limit with its pace, turn,
speed, cost, cache, context) that wraps onto new lines as the space narrows. Colour marks
warnings only: a tight or lost limit, the cache running out, a nearly full context.

- `/session_panel`: show or hide the stats.
- `/session_panel band`: move the stats to the band above the prompt, leaving the side pane
  free for Files and the rest. Kept for later sessions.
- `/session_panel pane`: move them back to the side pane.
- `/session_panel demo <minutes>`: preview the cache warning colors.

The macOS notifier is optional: build it with `notifier/build.sh` in this folder.

## Install

```
/plugin install session-panel --marketplace thisisvillegas/claude-mods
```
