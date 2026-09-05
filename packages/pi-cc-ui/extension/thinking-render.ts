import type { Theme } from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'
import { Markdown, MouseRegion, TruncatedText, truncateToWidth } from '@earendil-works/pi-tui'

import { formatDuration } from './format.js'
import { isRecord, isUnknownArray } from './guards.js'
import { isThinkingMessage, thinkingRuns } from './thinking-state.js'
import type { ThinkingMessage, ThinkingState } from './thinking-state.js'

export const THINKING_TITLE = '∴ Thinking…'
const THINKING_INDENT = '  '
const MS_PER_SECOND = 1000

interface ThinkingHost {
  hideThinkingBlock: boolean
  thinkingVisibilityOverrides: Map<unknown, unknown>
  readonly contentContainer: { readonly children: Component[] }
  readonly outputPad: number
  readonly isStreaming: boolean
  readonly lastMessage: ThinkingMessage | undefined
}

export interface ThinkingRenderOptions {
  readonly thinking: ThinkingState
  readonly getTheme: () => Theme
}

interface ThinkingRowOptions extends ThinkingRenderOptions {
  readonly host: ThinkingHost
  readonly message: ThinkingMessage
  readonly indexes: readonly number[]
  readonly runIndex: number
}

const visibilityRevisions = new WeakMap<object, number>()

function isComponent(value: unknown): value is Component {
  return (
    isRecord(value) &&
    typeof value['render'] === 'function' &&
    typeof value['invalidate'] === 'function'
  )
}

function isThinkingHost(value: object): value is ThinkingHost {
  if (!isRecord(value)) {
    return false
  }
  const container = value['contentContainer']
  return (
    typeof value['hideThinkingBlock'] === 'boolean' &&
    value['thinkingVisibilityOverrides'] instanceof Map &&
    typeof value['outputPad'] === 'number' &&
    typeof value['isStreaming'] === 'boolean' &&
    (value['lastMessage'] === undefined || isThinkingMessage(value['lastMessage'])) &&
    isRecord(container) &&
    isUnknownArray(container['children']) &&
    container['children'].every((child) => isComponent(child))
  )
}

function thinkingMarkdown(component: Component): Markdown | undefined {
  if (!(component instanceof MouseRegion) || !isRecord(component)) {
    return undefined
  }
  const record: Record<string, unknown> = component
  const child = record['child']
  return child instanceof Markdown ? child : undefined
}

function thoughtTitle(ms: number | undefined): string {
  if (ms === undefined) {
    return '∴ Thought'
  }
  return `∴ Thought for ${ms < MS_PER_SECOND ? '<1s' : formatDuration(ms)}`
}

class ThinkingRow implements Component {
  private readonly markdown: Markdown
  private readonly options: ThinkingRowOptions

  constructor(markdown: Markdown, options: ThinkingRowOptions) {
    this.markdown = markdown
    this.options = options
  }

  private isActive(): boolean {
    const { host, thinking, message, indexes } = this.options
    return host.isStreaming && thinking.isActive(message, indexes)
  }

  private isExpanded(): boolean {
    const { host, thinking, runIndex } = this.options
    const hidden = host.thinkingVisibilityOverrides.get(runIndex)
    return typeof hidden === 'boolean' ? !hidden : thinking.isForcedExpanded() || this.isActive()
  }

  toggle(): void {
    this.options.host.thinkingVisibilityOverrides.set(this.options.runIndex, this.isExpanded())
  }

  hover(): boolean {
    const { thinking, message, runIndex } = this.options
    return thinking.hoverRow(message, runIndex)
  }

  render(width: number): string[] {
    if (width < 1) {
      return []
    }
    const { getTheme, host, thinking, message, indexes, runIndex } = this.options
    const theme = getTheme()
    const title = this.isActive()
      ? THINKING_TITLE
      : thoughtTitle(thinking.duration(message, indexes))
    const text = thinking.isHovered(message, runIndex) ? title : theme.fg('dim', title)
    const header = new TruncatedText(theme.italic(text), host.outputPad, 0)
    const lines = header.render(width)
    if (this.isExpanded()) {
      const contentWidth = Math.max(1, width - THINKING_INDENT.length)
      lines.push(...this.markdown.render(contentWidth).map((line) => THINKING_INDENT + line))
    }
    return lines.map((line) => truncateToWidth(line, width, ''))
  }

  invalidate(): void {
    this.markdown.invalidate()
  }
}

function decorateThinking(host: ThinkingHost, options: ThinkingRenderOptions): void {
  const message = host.lastMessage
  if (message === undefined) {
    return
  }
  const revision = options.thinking.visibilityRevision()
  if (visibilityRevisions.get(host) !== revision) {
    host.thinkingVisibilityOverrides.clear()
    visibilityRevisions.set(host, revision)
  }
  const runs = thinkingRuns(message)
  let runIndex = 0
  for (const [index, child] of host.contentContainer.children.entries()) {
    const markdown = thinkingMarkdown(child)
    if (markdown === undefined) {
      continue
    }
    const indexes = runs[runIndex]
    if (indexes === undefined) {
      break
    }
    const row = new ThinkingRow(markdown, { ...options, host, message, indexes, runIndex })
    host.contentContainer.children[index] = new MouseRegion(row, (event) => {
      if (event.type === 'move' && event.y === 0) {
        return { handled: true, render: row.hover() }
      }
      if (event.type !== 'click' || event.button !== 'left') {
        return undefined
      }
      row.toggle()
      return { handled: true, render: true }
    })
    runIndex += 1
  }
}

export function updateThinkingContent(
  component: object,
  update: () => unknown,
  options: ThinkingRenderOptions,
): unknown {
  if (!isThinkingHost(component)) {
    return update()
  }
  const hidden = component.hideThinkingBlock
  const overrides = component.thinkingVisibilityOverrides
  component.hideThinkingBlock = false
  component.thinkingVisibilityOverrides = new Map()
  let result: unknown
  try {
    result = update()
  } finally {
    component.hideThinkingBlock = hidden
    component.thinkingVisibilityOverrides = overrides
  }
  decorateThinking(component, options)
  return result
}
