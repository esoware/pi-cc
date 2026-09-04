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

Its own preferences live in `~/.pi/agent/pi-cc-ui.json`. Tool grouping and extra detail are written there by `/cc-tools`; `wheelScrollLines` is read from it but never written.

## What it changes

- Themes: `pi-cc-ui-dark` and `pi-cc-ui-light`, each with an `-ansi` variant for 16-color terminals and a `-daltonized` variant for color-blind users.
- Startup header showing the pi version, the model and effort, and your installed extensions and skills.
- Status line: `cwd │ model · effort │ 56.4k █░░░░░░░ 1.0m │ turns`. The eight tiles fill as the context window does.
- Spinner with elapsed time, output tokens, and whether the model is thinking.
- Consecutive read, grep, find, ls and read-only bash calls collapse into one group. Results hang off `⎿`.
- Edit and overwrite results render as Claude Code style diffs: line number, sign, content, with full-width backgrounds on changed lines and highlighted changed words. New-file writes list the file with line numbers.
- pi-cc-ui registers no tools of its own. It patches the host's tool component, so every tool call, including extension and MCP tools, gets the same `●` header and `⎿` result framing instead of the host's padded box. pi's built-in `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find` and `ls` get custom renderers only while pi itself owns those names; an extension that replaces one keeps its own renderer inside the frame, whatever the package order. Headers show the real tool name (`Read`, `Write`, `Edit`, `Bash`, `Grep`, `Find`, `Ls`).
- In fullscreen mode the mouse wheel scrolls 3 lines per tick instead of pi's 1. Set `"wheelScrollLines"` in `~/.pi/agent/pi-cc-ui.json` to change it.
- Thinking is hidden. `alt+t` shows it.
- A line after every turn saying how long it took.

## Commands and keys

- `/cc-theme` picks a theme.
- `/cc-tools group on|off|toggle` and `/cc-tools detail on|off|toggle` control grouping and extra detail; `/cc-tools status` reports both. `ctrl+shift+o` also toggles extra detail, or `alt+o` if your terminal lacks the Kitty keyboard protocol.
- `alt+t` toggles thinking visibility.

## License

MIT. The copyright notice for the original better-claude-code-ui is in LICENSE.
