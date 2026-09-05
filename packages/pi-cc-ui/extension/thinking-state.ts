import type { MessageUpdateEvent } from '@earendil-works/pi-coding-agent'

import { isRecord, isUnknownArray } from './guards.js'
import type { ThinkingMode } from './settings.js'

export interface ThinkingMessage {
  readonly provider: string
  readonly model: string
  readonly timestamp: number
  readonly content: readonly unknown[]
}

interface ThinkingBlock {
  readonly type: 'thinking'
  readonly thinking: string
}

interface ActiveThinking {
  readonly key: string
  readonly index: number
  readonly startedAt: number
}

interface HoveredThinking {
  readonly key: string
  readonly runIndex: number
}

interface BlockDuration {
  readonly index: number
  readonly ms: number
}

export interface ThinkingTiming {
  readonly key: string
  readonly blocks: readonly BlockDuration[]
}

export function isThinkingMessage(value: unknown): value is ThinkingMessage {
  return (
    isRecord(value) &&
    typeof value['provider'] === 'string' &&
    typeof value['model'] === 'string' &&
    typeof value['timestamp'] === 'number' &&
    isUnknownArray(value['content'])
  )
}

function isThinkingBlock(value: unknown): value is ThinkingBlock {
  return isRecord(value) && value['type'] === 'thinking' && typeof value['thinking'] === 'string'
}

export function thinkingRuns(message: ThinkingMessage): number[][] {
  const runs: number[][] = []
  let run: number[] = []
  for (const [index, block] of message.content.entries()) {
    if (isThinkingBlock(block)) {
      if (block.thinking.trim() !== '') {
        run.push(index)
      }
    } else if (run.length > 0) {
      runs.push(run)
      run = []
    }
  }
  if (run.length > 0) {
    runs.push(run)
  }
  return runs
}

function messageKey(message: ThinkingMessage): string {
  return JSON.stringify([message.provider, message.model, message.timestamp])
}

function isBlockDuration(value: unknown): value is BlockDuration {
  return (
    isRecord(value) &&
    typeof value['index'] === 'number' &&
    Number.isInteger(value['index']) &&
    value['index'] >= 0 &&
    typeof value['ms'] === 'number' &&
    Number.isFinite(value['ms']) &&
    value['ms'] >= 0
  )
}

export class ThinkingState {
  private readonly timings = new Map<string, Map<number, number>>()
  private active: ActiveThinking | undefined = undefined
  private expanded = false
  private toolsExpanded = false
  private revision = 0
  private hovered: HoveredThinking | undefined = undefined
  private hoverSeen = false

  reset(mode: ThinkingMode = 'live'): void {
    this.active = undefined
    this.timings.clear()
    this.toolsExpanded = false
    this.clearHover()
    this.setExpanded(mode === 'full')
  }

  isExpanded(): boolean {
    return this.expanded
  }

  isForcedExpanded(): boolean {
    return this.expanded || this.toolsExpanded
  }

  visibilityRevision(): number {
    return this.revision
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded
    this.revision += 1
  }

  setToolsExpanded(expanded: boolean): void {
    if (this.toolsExpanded !== expanded) {
      this.toolsExpanded = expanded
      this.revision += 1
    }
  }

  isHovered(message: ThinkingMessage, runIndex: number): boolean {
    return this.hovered?.key === messageKey(message) && this.hovered.runIndex === runIndex
  }

  hoverRow(message: ThinkingMessage, runIndex: number): boolean {
    this.hoverSeen = true
    if (this.isHovered(message, runIndex)) {
      return false
    }
    this.hovered = { key: messageKey(message), runIndex }
    return true
  }

  beginHoverProbe(): void {
    this.hoverSeen = false
  }

  endHoverProbe(): boolean {
    return !this.hoverSeen && this.clearHover()
  }

  clearHover(): boolean {
    const changed = this.hovered !== undefined
    this.hovered = undefined
    return changed
  }

  update(message: ThinkingMessage, update: MessageUpdateEvent['assistantMessageEvent']): void {
    if (update.type === 'thinking_start' || update.type === 'thinking_delta') {
      const key = messageKey(message)
      const index = update.contentIndex
      if (this.active?.key === key && this.active.index === index) {
        return
      }
      this.finish()
      if (this.timings.get(key)?.has(index) !== true) {
        this.active = { key, index, startedAt: Date.now() }
      }
    } else {
      this.finish(message)
    }
  }

  finish(message?: ThinkingMessage): void {
    const active = this.active
    if (active === undefined || (message !== undefined && messageKey(message) !== active.key)) {
      return
    }
    const blocks = this.timings.get(active.key) ?? new Map<number, number>()
    blocks.set(active.index, Math.max(0, Date.now() - active.startedAt))
    this.timings.set(active.key, blocks)
    this.active = undefined
  }

  isActive(message: ThinkingMessage, indexes: readonly number[]): boolean {
    return (
      this.active !== undefined &&
      this.active.key === messageKey(message) &&
      indexes.includes(this.active.index)
    )
  }

  duration(message: ThinkingMessage, indexes: readonly number[]): number | undefined {
    const blocks = this.timings.get(messageKey(message))
    let total = 0
    for (const index of indexes) {
      const ms = blocks?.get(index)
      if (ms === undefined) {
        return undefined
      }
      total += ms
    }
    return indexes.length === 0 ? undefined : total
  }

  snapshot(message: ThinkingMessage): ThinkingTiming | undefined {
    const key = messageKey(message)
    const blocks = this.timings.get(key)
    return blocks === undefined
      ? undefined
      : { key, blocks: [...blocks].map(([index, ms]) => ({ index, ms })) }
  }

  restore(value: unknown): void {
    if (!isRecord(value) || typeof value['key'] !== 'string' || !isUnknownArray(value['blocks'])) {
      return
    }
    const blocks = value['blocks']
    if (blocks.every((block) => isBlockDuration(block))) {
      this.timings.set(value['key'], new Map(blocks.map((block) => [block.index, block.ms])))
    }
  }
}
