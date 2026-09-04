import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent'

import type { Settings } from './settings.js'
import type { ToolGroups } from './tools/groups.js'

const THEME_PREFIX = 'pi-cc-ui-'
const ARGUMENT_SEPARATOR_RE = /\s+/u

function notify(ctx: ExtensionContext, message: string, kind: 'info' | 'error' = 'info'): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, kind)
  }
}

function onOff(enabled: boolean): string {
  return enabled ? 'on' : 'off'
}

function requestedValue(word: string | undefined, current: boolean): boolean {
  if (word === 'on') {
    return true
  }
  return word === 'off' ? false : !current
}

async function runThemeCommand(ctx: ExtensionCommandContext): Promise<void> {
  if (!ctx.hasUI) {
    return
  }
  const themes = ctx.ui
    .getAllThemes()
    .map((theme) => theme.name)
    .filter((name) => name.startsWith(THEME_PREFIX))
    .toSorted()
  if (themes.length === 0) {
    ctx.ui.notify('No pi-cc-ui themes are installed.', 'error')
    return
  }
  const current = ctx.ui.theme.name
  const title = current === undefined ? 'pi-cc-ui theme' : `pi-cc-ui theme (current: ${current})`
  const choice = await ctx.ui.select(title, themes)
  if (choice === undefined) {
    return
  }
  const result = ctx.ui.setTheme(choice)
  if (result.success) {
    ctx.ui.notify(`Theme: ${choice}`, 'info')
    return
  }
  ctx.ui.notify(`Theme switch failed: ${result.error ?? choice}`, 'error')
}

export function registerCommands(pi: ExtensionAPI, settings: Settings, groups: ToolGroups): void {
  function applyToolGrouping(ctx: ExtensionContext, enabled: boolean): void {
    settings.setToolGroupingEnabled(enabled)
    groups.repaintRows()
    notify(ctx, `Tool grouping: ${onOff(enabled)}`)
  }

  function applyExtraDetail(ctx: ExtensionContext, enabled: boolean): void {
    settings.setExtraDetailEnabled(enabled)
    groups.repaintRows()
    notify(ctx, `Extra detail: ${onOff(enabled)}`)
  }

  function reportToolSettings(ctx: ExtensionContext): void {
    notify(
      ctx,
      [
        `Tool grouping: ${onOff(settings.isToolGroupingEnabled())}`,
        `Extra detail: ${onOff(settings.isExtraDetailEnabled())} (ctrl+shift+o, or alt+o on legacy terminals)`,
        '  /cc-tools group on|off|toggle',
        '  /cc-tools detail on|off|toggle',
      ].join('\n'),
    )
  }

  function runToolsCommand(args: string, ctx: ExtensionCommandContext): void {
    const words = args
      .trim()
      .toLowerCase()
      .split(ARGUMENT_SEPARATOR_RE)
      .filter((word) => word !== '')
    const option = words[0]
    const value = words[1]

    if (option === 'group') {
      applyToolGrouping(ctx, requestedValue(value, settings.isToolGroupingEnabled()))
      return
    }
    if (option === 'detail' || option === 'extra') {
      applyExtraDetail(ctx, requestedValue(value, settings.isExtraDetailEnabled()))
      return
    }
    if (option !== undefined && option !== 'status') {
      notify(ctx, `Unknown option "${option}". Try /cc-tools status.`, 'error')
      return
    }
    reportToolSettings(ctx)
  }

  function toggleExtraDetail(ctx: ExtensionContext): void {
    applyExtraDetail(ctx, !settings.isExtraDetailEnabled())
  }

  pi.registerCommand('cc-tools', {
    description: 'Control tool UI: grouping, extra detail',
    handler(args, ctx) {
      runToolsCommand(args, ctx)
      return Promise.resolve()
    },
  })

  pi.registerCommand('cc-theme', {
    description: 'Pick a pi-cc-ui theme',
    handler: (_args, ctx) => runThemeCommand(ctx),
  })

  pi.registerShortcut('ctrl+shift+o', {
    description: 'Toggle tool extra-detail mode',
    handler: toggleExtraDetail,
  })

  pi.registerShortcut('alt+o', {
    description:
      'Toggle tool extra-detail mode (fallback for terminals without the Kitty keyboard protocol)',
    handler: toggleExtraDetail,
  })
}
