import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { truncateToWidth } from '@earendil-works/pi-tui'

import { pluralize } from './format.js'
import { tildeHome } from './paths.js'

const TOKENS_PER_K = 1000
const TOKENS_PER_M = 1_000_000
const CONTEXT_WARN_RATIO = 0.9
const CONTEXT_TILES = 8
const FILLED_TILE = '█'
const EMPTY_TILE = '░'
const NO_MODEL_LABEL = 'no-model'

function formatContextTokens(tokens: number): string {
  if (tokens < TOKENS_PER_K) {
    return String(tokens)
  }
  if (tokens < TOKENS_PER_M) {
    return `${(tokens / TOKENS_PER_K).toFixed(1)}k`
  }
  return `${(tokens / TOKENS_PER_M).toFixed(1)}m`
}

function contextTiles(tokens: number, window: number): { filled: string; empty: string } {
  const ratio = Math.min(1, Math.max(0, tokens / window))
  const filled = Math.min(CONTEXT_TILES, Math.ceil(ratio * CONTEXT_TILES))
  return {
    filled: FILLED_TILE.repeat(filled),
    empty: EMPTY_TILE.repeat(CONTEXT_TILES - filled),
  }
}

export function registerStatusLine(pi: ExtensionAPI): void {
  let turns = 0

  pi.on('message_end', (event) => {
    if (event.message.role === 'user') {
      turns += 1
    }
  })

  pi.on('session_start', (_event, ctx) => {
    turns = 0
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'message' && entry.message.role === 'user') {
        turns += 1
      }
    }

    if (ctx.mode !== 'tui') {
      return
    }

    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => {
        tui.requestRender()
      })
      return {
        dispose: unsubscribe,
        invalidate() {},
        render(width: number): string[] {
          const separator = theme.fg('dim', ' │ ')

          const cwd = theme.fg('muted', tildeHome(ctx.cwd))

          const model = ctx.model?.id ?? NO_MODEL_LABEL
          const modelPart = `${theme.fg('muted', model)}${theme.fg('dim', ` · ${pi.getThinkingLevel()}`)}`

          const usage = ctx.getContextUsage()
          const tokens = usage?.tokens ?? 0
          const usageWindow = usage?.contextWindow ?? 0
          const window = usageWindow > 0 ? usageWindow : (ctx.model?.contextWindow ?? 0)
          const warn = window > 0 && tokens > window * CONTEXT_WARN_RATIO
          const used = theme.fg(warn ? 'warning' : 'dim', formatContextTokens(tokens))
          let contextPart = used
          if (window > 0) {
            const tiles = contextTiles(tokens, window)
            const bar = `${theme.fg(warn ? 'warning' : 'muted', tiles.filled)}${theme.fg('dim', tiles.empty)}`
            contextPart = `${used} ${bar} ${theme.fg('dim', formatContextTokens(window))}`
          }

          const turnsPart = theme.fg('dim', `${turns} ${pluralize(turns, 'turn')}`)

          return [
            truncateToWidth([cwd, modelPart, contextPart, turnsPart].join(separator), width, ''),
          ]
        },
      }
    })
  })
}
