# pi-cc-ui

Makes [pi](https://pi.dev) look like Claude Code, in light blue instead of orange. Fork of [better-claude-code-ui](https://www.npmjs.com/package/better-claude-code-ui).

![pi-cc-ui](https://raw.githubusercontent.com/esoware/pi-cc/main/packages/pi-cc-ui/media/cover.png)

## Install

```sh
pi install npm:@esoware/pi-cc-ui
```

Or from a checkout of this repo:

```sh
pnpm install
pi install /absolute/path/to/pi-cc/packages/pi-cc-ui
```

If `npm:better-claude-code-ui` is in your packages, remove it first. Both register the same commands and shortcuts.

Settings that go with it, in `~/.pi/agent/settings.json`:

```json
{ "quietStartup": true, "theme": "pi-cc-ui-dark", "outputPad": 0 }
```

`outputPad: 0` also removes the one-column padding pi applies elsewhere, so everything lines up flush left.

Its own preferences live in `~/.pi/agent/pi-cc-ui.json`. Tool grouping and `thinkingMode` are written there by `/cc-tools`; `wheelScrollLines` is read from it but never written.

## What it changes

- Themes: `pi-cc-ui-dark` and `pi-cc-ui-light`, each with an `-ansi` variant for 16-color terminals and a `-daltonized` variant for color-blind users.
- Startup header showing the pi version, the model and effort, and your installed extensions and skills.
- Status line: `cwd │ model · effort │ 56.4k █░░░░░░░ 1.0m │ turns`. The eight tiles fill as the context window does.
- Spinner with elapsed time, output tokens, and whether the model is thinking.
- Running Bash headers show an elapsed timer after 2 seconds, even without output. Collapsed groups show the longest-running active Bash command's timer; it disappears when no Bash commands are running.
- Consecutive shell commands collapse into `Running 2 shell commands…` with the latest command previewed under `⎿`, then `Ran 2 shell commands` once they finish. Read, grep, find and ls runs do the same with `Read 3 files, searched for 2 patterns`. Expanding a group shows every call as a normal `●` row with its full output, all inside one background block.
- Collapsed results hang off `⎿` and stay short: a stat line for read, grep, find and ls, the first three lines plus `… +N lines` for bash, and the diff for edits and writes. `ctrl+o` expands every row, and in fullscreen mode clicking a row expands just that one. An expanded row shows the full command in the header and the whole result, painted with the tool background color from the theme.
- Edit and overwrite results render as Claude Code style diffs: line number, sign, content, with full-width backgrounds on changed lines and highlighted changed words. New-file writes list the file with line numbers.
- pi-cc-ui registers no tools of its own. It patches the host's tool component, so every tool call, including extension and MCP tools, gets the same `●` header and `⎿` result framing instead of the host's padded box. pi's built-in `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find` and `ls` get custom renderers only while pi itself owns those names; an extension that replaces one keeps its own renderer inside the frame, whatever the package order. Headers show the real tool name (`Read`, `Write`, `Edit`, `Bash`, `Grep`, `Find`, `Ls`).
- In fullscreen mode the mouse wheel scrolls 3 lines per tick instead of pi's 1. Set `"wheelScrollLines"` in `~/.pi/agent/pi-cc-ui.json` to change it.
- Thinking expands only while it streams, under a muted `∴ Thinking…` heading with indented text. When it finishes, it collapses to `∴ Thought for 4s`. Thinking with visible text has its own row, so tool groups never span it or repeat it in their summaries. Empty thinking metadata doesn't split groups. `/cc-tools thinking full` keeps thinking expanded. `alt+t` toggles full/live-only display for the session; `ctrl+o` also expands thinking, and fullscreen clicks toggle individual thinking rows. Measured durations survive reload/resume as separate session metadata, without changing messages or model context. Older thoughts without a recorded duration simply show `∴ Thought`.
- Assistant messages start with `●`, with continuation lines indented under it, like Claude Code.
- A line after every turn saying how long it took.

## Commands and keys

- `/cc-theme` picks a theme.
- `/cc-tools group on|off|toggle` controls grouping.
- `/cc-tools thinking live|full` saves the thinking display mode (`live` is the default); `/cc-tools thinking status` reports it.
- `alt+t` toggles full/live-only thinking without changing the saved mode. Pi's native thinking shortcut (`ctrl+t` by default) does the same.
- `ctrl+o` expands/collapses tool output and thinking together. Collapsing restores the selected thinking mode.

## License

MIT. The copyright notice for the original better-claude-code-ui is in LICENSE.
