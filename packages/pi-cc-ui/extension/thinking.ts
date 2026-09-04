import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

import { dim, italic } from './ansi.js'

const THINKING_TITLE = '∴ Thinking…'

export class ThinkingVisibility {
  private expanded = false

  isExpanded(): boolean {
    return this.expanded
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded
  }
}

function repaintThinking(ctx: ExtensionContext): void {
  ctx.ui.setHiddenThinkingLabel(THINKING_TITLE)
}

export function registerThinking(pi: ExtensionAPI, thinking: ThinkingVisibility): void {
  pi.registerMarkdownTransformer((markdown, context) => {
    if (context.messageType !== 'assistant-thinking') {
      return markdown
    }
    if (!thinking.isExpanded()) {
      return ''
    }
    const body = markdown.trim()
    if (body === '') {
      return markdown
    }
    return `${dim(italic(THINKING_TITLE))}\n\n${body}`
  })

  pi.on('session_start', (_event, ctx) => {
    thinking.setExpanded(false)
    if (ctx.hasUI) {
      repaintThinking(ctx)
    }
  })

  pi.registerShortcut('alt+t', {
    description: 'Toggle thinking visibility',
    handler(ctx) {
      const expanded = !thinking.isExpanded()
      thinking.setExpanded(expanded)
      if (ctx.hasUI) {
        repaintThinking(ctx)
        ctx.ui.notify(`Thinking: ${expanded ? 'expanded' : 'hidden'}`, 'info')
      }
    },
  })
}
