import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import type { Settings } from './settings.js'
import { THINKING_TITLE } from './thinking-render.js'
import type { ThinkingState } from './thinking-state.js'

const THINKING_TIMING_ENTRY = 'cc-thinking-timing'

export function repaintThinking(ctx: ExtensionContext): void {
  if (ctx.mode === 'tui') {
    ctx.ui.setHiddenThinkingLabel(THINKING_TITLE)
  }
}

export function registerThinking(
  pi: ExtensionAPI,
  thinking: ThinkingState,
  settings: Settings,
): void {
  pi.on('session_start', (_event, ctx) => {
    thinking.reset(settings.thinkingMode())
    if (ctx.mode !== 'tui') {
      return
    }
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === 'custom' && entry.customType === THINKING_TIMING_ENTRY) {
        thinking.restore(entry.data)
      }
    }
    thinking.setToolsExpanded(ctx.ui.getToolsExpanded())
    repaintThinking(ctx)
  })

  pi.on('session_shutdown', () => {
    thinking.reset()
  })

  pi.on('message_start', (event, ctx) => {
    if (ctx.mode === 'tui' && event.message.role === 'assistant') {
      thinking.finish()
    }
  })

  pi.on('message_update', (event, ctx) => {
    if (ctx.mode === 'tui' && event.message.role === 'assistant') {
      thinking.update(event.message, event.assistantMessageEvent)
    }
  })

  pi.on('message_end', (event, ctx) => {
    if (ctx.mode !== 'tui' || event.message.role !== 'assistant') {
      return
    }
    thinking.finish(event.message)
    const timing = thinking.snapshot(event.message)
    if (timing !== undefined) {
      pi.appendEntry(THINKING_TIMING_ENTRY, timing)
    }
  })

  pi.on('agent_end', (_event, ctx) => {
    thinking.finish()
    repaintThinking(ctx)
  })

  pi.on('session_tree', () => {
    thinking.finish()
  })

  pi.registerShortcut('alt+t', {
    description: 'Toggle full or live-only thinking',
    handler(ctx) {
      thinking.setExpanded(!thinking.isExpanded())
      repaintThinking(ctx)
      if (ctx.hasUI) {
        ctx.ui.notify(`Thinking: ${thinking.isExpanded() ? 'full' : 'live-only'}`, 'info')
      }
    },
  })
}
