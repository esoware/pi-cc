import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import type { FormatPath } from '../paths.js'
import type { Settings } from '../settings.js'
import { classifyToolCall, formatGlanceHint, readToolCallArguments } from './classify.js'
import type { GlanceHint, ToolCallArguments, ToolGlance } from './classify.js'

const MAX_ARCHIVED_GROUPS = 500
const MAX_TRACKED_ROWS = 1000
const BLINK_INTERVAL_MS = 600
const HINT_MIN_DISPLAY_MS = 700
const BASH_TIMER_DELAY_MS = 2000
const BASH_TIMER_INTERVAL_MS = 1000

type Timer = ReturnType<typeof setTimeout>
type Interval = ReturnType<typeof setInterval>

type ToolStatus = 'pending' | 'success' | 'error'
type GroupPhase = 'live' | 'settled'

export interface ToolRecord {
  readonly toolCallId: string
  readonly toolName: string
  readonly args: ToolCallArguments
  readonly glance: ToolGlance | undefined
  status: ToolStatus
}

interface RunningBash {
  readonly startedAt: number
  readonly timer: Interval
}

interface ShownHint {
  readonly text: string
  readonly shownAt: number
}

interface ScheduledHint {
  text: string
  readonly timer: Timer
}

interface HintState {
  shown: ShownHint | undefined
  scheduled: ScheduledHint | undefined
}

export interface ToolGroup {
  readonly members: ToolRecord[]
  phase: GroupPhase
  contentAfter: boolean
  hint: HintState
}

export interface RowHandle {
  readonly invalidate: () => void
  readonly isExpanded: () => boolean
  readonly setExpanded: (expanded: boolean) => void
}

export interface GroupMembership {
  readonly group: ToolGroup
  readonly isLeader: boolean
  readonly expanded: boolean
}

export interface ToolUi {
  readonly groups: ToolGroups
}

type TurnEntry = { readonly kind: 'tool'; readonly toolCallId: string } | { readonly kind: 'break' }

function hasPendingMember(members: readonly ToolRecord[]): boolean {
  return members.some((member) => member.status === 'pending')
}

function createGroup(members: ToolRecord[]): ToolGroup {
  return {
    members,
    phase: hasPendingMember(members) ? 'live' : 'settled',
    contentAfter: false,
    hint: { shown: undefined, scheduled: undefined },
  }
}

function latestHint(group: ToolGroup): GlanceHint | undefined {
  const newestFirst = group.members.toReversed()
  const member =
    newestFirst.find(
      (candidate) => candidate.status === 'pending' && candidate.glance?.hint !== undefined,
    ) ?? newestFirst.find((candidate) => candidate.glance?.hint !== undefined)
  return member?.glance?.hint
}

export class ToolGroups {
  private readonly settings: Settings
  private readonly rowHandles = new Map<string, RowHandle>()
  private readonly blinkingRows = new Map<string, () => void>()
  private readonly runningBash = new Map<string, RunningBash>()
  private records = new Map<string, ToolRecord>()
  private turnOrder: TurnEntry[] = []
  private liveGroups: ToolGroup[] = []
  private archivedGroups: ToolGroup[] = []
  private blinkTimer: Interval | undefined = undefined
  private blinkOn = true
  private blinkEnabled = false
  private agentDepth = 0
  private hovered: string | undefined = undefined
  private hoverSeen = false

  constructor(pi: ExtensionAPI, settings: Settings) {
    this.settings = settings

    pi.on('session_start', (_event, ctx) => {
      this.reset()
      this.blinkEnabled = ctx.mode === 'tui'
    })

    pi.on('session_shutdown', () => {
      this.reset()
      this.blinkEnabled = false
    })

    pi.on('agent_start', () => {
      this.agentDepth += 1
      if (this.agentDepth === 1) {
        this.archiveGroups()
        this.startTurn()
      }
    })

    pi.on('agent_end', () => {
      this.agentDepth = Math.max(0, this.agentDepth - 1)
      queueMicrotask(() => {
        if (this.agentDepth === 0) {
          this.settleLeakedGroups()
          this.stopBlink()
        }
      })
    })

    pi.on('message_update', (event) => {
      const update = event.assistantMessageEvent
      if (!('contentIndex' in update)) {
        return
      }
      const block = update.partial.content[update.contentIndex]
      if (
        (block?.type === 'thinking' && block.thinking.trim() !== '') ||
        (block?.type === 'text' && block.text.trim() !== '')
      ) {
        this.breakGroupRun()
      }
    })

    pi.on('tool_execution_start', (event) => {
      const args = readToolCallArguments(event.args)
      const glance = classifyToolCall(event.toolName, args)
      this.records.set(event.toolCallId, {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args,
        glance,
        status: 'pending',
      })
      if (event.toolName === 'bash') {
        this.startBashTimer(event.toolCallId)
      }
      this.turnOrder.push({ kind: 'tool', toolCallId: event.toolCallId })
      this.rebuildGroups()
      this.invalidateGroups()
      if (glance !== undefined) {
        this.ensureBlink()
      }
    })

    pi.on('tool_execution_end', (event) => {
      this.stopBashTimer(event.toolCallId)
      this.blinkingRows.delete(event.toolCallId)
      const record = this.records.get(event.toolCallId)
      if (record === undefined) {
        return
      }
      record.status = event.isError ? 'error' : 'success'
      const group = this.groupOf(event.toolCallId)
      if (group !== undefined) {
        this.updatePhase(group)
      }
      this.invalidateGroups()
    })
  }

  membership(toolCallId: string): GroupMembership | undefined {
    if (!this.settings.isToolGroupingEnabled()) {
      return undefined
    }
    const group = this.groupOf(toolCallId)
    const leaderId = group?.members[0]?.toolCallId
    if (group === undefined || leaderId === undefined) {
      return undefined
    }
    return {
      group,
      isLeader: leaderId === toolCallId,
      expanded: this.rowHandles.get(leaderId)?.isExpanded() ?? false,
    }
  }

  setGroupExpanded(toolCallId: string, expanded: boolean): void {
    const group = this.groupOf(toolCallId)
    if (group === undefined) {
      return
    }
    const leaderId = group.members[0]?.toolCallId
    if (leaderId !== undefined) {
      this.rowHandles.get(leaderId)?.setExpanded(expanded)
    }
    for (const member of group.members) {
      this.rowHandles.get(member.toolCallId)?.invalidate()
    }
  }

  trackRow(toolCallId: string, handle: RowHandle): void {
    this.rowHandles.set(toolCallId, handle)
    while (this.rowHandles.size > MAX_TRACKED_ROWS) {
      const oldest = this.rowHandles.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.rowHandles.delete(oldest)
    }
  }

  repaintRows(): void {
    for (const handle of this.rowHandles.values()) {
      handle.invalidate()
    }
  }

  isHovered(toolCallId: string): boolean {
    return this.hovered === toolCallId
  }

  hoverRow(toolCallId: string): boolean {
    this.hoverSeen = true
    const changed = this.hovered !== toolCallId
    this.setHovered(toolCallId)
    return changed
  }

  beginHoverProbe(): void {
    this.hoverSeen = false
  }

  endHoverProbe(): void {
    if (!this.hoverSeen) {
      this.clearHover()
    }
  }

  clearHover(): void {
    this.setHovered(undefined)
  }

  keepBlinking(): boolean {
    this.ensureBlink()
    return this.blinkOn
  }

  keepRowBlinking(toolCallId: string, invalidate: () => void): boolean {
    this.blinkingRows.set(toolCallId, invalidate)
    return this.keepBlinking()
  }

  bashElapsedMsFor(toolCallId: string): number | undefined {
    const running = this.runningBash.get(toolCallId)
    if (running === undefined) {
      return undefined
    }
    const elapsedMs = Date.now() - running.startedAt
    return elapsedMs >= BASH_TIMER_DELAY_MS ? elapsedMs : undefined
  }

  groupBashElapsedMsFor(group: ToolGroup): number | undefined {
    let elapsedMs: number | undefined
    for (const member of group.members) {
      const memberElapsedMs = this.bashElapsedMsFor(member.toolCallId)
      if (memberElapsedMs !== undefined) {
        elapsedMs = Math.max(elapsedMs ?? 0, memberElapsedMs)
      }
    }
    return elapsedMs
  }

  hintTextFor(group: ToolGroup, formatPath: FormatPath): string | undefined {
    const hint = group.phase === 'live' ? latestHint(group) : undefined
    return this.resolveHint(
      group,
      hint === undefined ? undefined : formatGlanceHint(hint, formatPath),
    )
  }

  private reset(): void {
    this.startTurn()
    this.archivedGroups = []
    this.hovered = undefined
    this.rowHandles.clear()
    this.blinkingRows.clear()
    this.agentDepth = 0
    this.stopBlink()
  }

  private startTurn(): void {
    this.stopBashTimers()
    for (const group of this.liveGroups) {
      this.cancelHintSwap(group)
    }
    this.records = new Map()
    this.turnOrder = []
    this.liveGroups = []
  }

  private archiveGroups(): void {
    for (const group of this.liveGroups) {
      for (const member of group.members) {
        member.status = member.status === 'pending' ? 'success' : member.status
      }
      group.phase = 'settled'
      this.cancelHintSwap(group)
      this.archivedGroups.push(group)
    }
    if (this.archivedGroups.length > MAX_ARCHIVED_GROUPS) {
      this.archivedGroups = this.archivedGroups.slice(-MAX_ARCHIVED_GROUPS)
    }
  }

  private settleLeakedGroups(): void {
    this.stopBashTimers()
    let changed = false
    for (const group of this.liveGroups) {
      for (const member of group.members) {
        if (member.status === 'pending') {
          member.status = 'error'
          changed = true
        }
      }
      if (group.phase === 'live') {
        group.phase = 'settled'
        changed = true
      }
      this.cancelHintSwap(group)
    }
    this.blinkingRows.clear()
    if (changed) {
      this.invalidateGroups()
    }
  }

  private rebuildGroups(): void {
    const rebuilt: ToolGroup[] = []
    let run: ToolRecord[] = []

    for (const entry of this.turnOrder) {
      const record = entry.kind === 'break' ? undefined : this.records.get(entry.toolCallId)
      if (record?.glance !== undefined) {
        run.push(record)
      } else if (entry.kind === 'break' || record !== undefined) {
        this.flushRun(rebuilt, run)
        run = []
      }
    }
    this.flushRun(rebuilt, run)

    for (const group of rebuilt) {
      const previous = this.liveGroups.find(
        (candidate) => candidate.members[0]?.toolCallId === group.members[0]?.toolCallId,
      )
      if (previous !== undefined) {
        group.hint = previous.hint
        group.contentAfter = previous.contentAfter
      }
    }
    this.liveGroups = rebuilt
  }

  private flushRun(groups: ToolGroup[], run: readonly ToolRecord[]): void {
    if (run.length === 0) {
      return
    }
    groups.push(createGroup([...run]))
  }

  private setHovered(toolCallId: string | undefined): void {
    const previous = this.hovered
    if (previous === toolCallId) {
      return
    }
    this.hovered = toolCallId
    for (const id of [previous, toolCallId]) {
      if (id !== undefined) {
        this.rowHandles.get(id)?.invalidate()
      }
    }
  }

  private groupOf(toolCallId: string): ToolGroup | undefined {
    function hasMember(group: ToolGroup): boolean {
      return group.members.some((member) => member.toolCallId === toolCallId)
    }
    return this.liveGroups.find(hasMember) ?? this.archivedGroups.find(hasMember)
  }

  private updatePhase(group: ToolGroup): void {
    const live =
      hasPendingMember(group.members) ||
      (this.agentDepth > 0 && this.liveGroups.at(-1) === group && !group.contentAfter)
    group.phase = live ? 'live' : 'settled'
  }

  private invalidateGroup(group: ToolGroup): void {
    const leaderId = group.members[0]?.toolCallId
    if (leaderId !== undefined) {
      this.rowHandles.get(leaderId)?.invalidate()
    }
  }

  private invalidateGroups(): void {
    for (const group of this.liveGroups) {
      this.invalidateGroup(group)
    }
  }

  private breakGroupRun(): void {
    const group = this.liveGroups.at(-1)
    if (group !== undefined) {
      group.contentAfter = true
      if (group.phase === 'live' && !hasPendingMember(group.members)) {
        group.phase = 'settled'
        this.cancelHintSwap(group)
        this.invalidateGroups()
      }
    }
    if (this.turnOrder.length > 0 && this.turnOrder.at(-1)?.kind !== 'break') {
      this.turnOrder.push({ kind: 'break' })
    }
  }

  private resolveHint(group: ToolGroup, incoming: string | undefined): string | undefined {
    const state = group.hint
    if (incoming === undefined) {
      this.cancelHintSwap(group)
      state.shown = undefined
      return undefined
    }
    const now = Date.now()
    const shown = state.shown
    if (shown === undefined) {
      state.shown = { text: incoming, shownAt: now }
      return incoming
    }
    if (incoming === shown.text) {
      return shown.text
    }
    const elapsed = now - shown.shownAt
    if (elapsed >= HINT_MIN_DISPLAY_MS) {
      this.cancelHintSwap(group)
      state.shown = { text: incoming, shownAt: now }
      return incoming
    }
    const scheduled = state.scheduled
    if (scheduled === undefined) {
      state.scheduled = {
        text: incoming,
        timer: this.scheduleHintSwap(group, HINT_MIN_DISPLAY_MS - elapsed),
      }
    } else {
      scheduled.text = incoming
    }
    return shown.text
  }

  private scheduleHintSwap(group: ToolGroup, delayMs: number): Timer {
    const timer = setTimeout(() => {
      const state = group.hint
      const scheduled = state.scheduled
      state.scheduled = undefined
      if (scheduled !== undefined) {
        state.shown = { text: scheduled.text, shownAt: Date.now() }
      }
      this.invalidateGroup(group)
    }, delayMs)
    timer.unref()
    return timer
  }

  private cancelHintSwap(group: ToolGroup): void {
    const scheduled = group.hint.scheduled
    if (scheduled !== undefined) {
      clearTimeout(scheduled.timer)
      group.hint.scheduled = undefined
    }
  }

  private startBashTimer(toolCallId: string): void {
    if (!this.blinkEnabled) {
      return
    }
    this.stopBashTimer(toolCallId)
    const startedAt = Date.now()
    const timer = setInterval(() => {
      if (this.bashElapsedMsFor(toolCallId) === undefined) {
        return
      }
      this.rowHandles.get(toolCallId)?.invalidate()
      const group = this.groupOf(toolCallId)
      if (group !== undefined && group.members[0]?.toolCallId !== toolCallId) {
        this.invalidateGroup(group)
      }
    }, BASH_TIMER_INTERVAL_MS)
    timer.unref()
    this.runningBash.set(toolCallId, { startedAt, timer })
  }

  private stopBashTimer(toolCallId: string): void {
    const running = this.runningBash.get(toolCallId)
    if (running !== undefined) {
      clearInterval(running.timer)
      this.runningBash.delete(toolCallId)
    }
  }

  private stopBashTimers(): void {
    for (const toolCallId of this.runningBash.keys()) {
      this.stopBashTimer(toolCallId)
    }
  }

  private ensureBlink(): void {
    if (!this.blinkEnabled || this.blinkTimer !== undefined) {
      return
    }
    const timer = setInterval(() => {
      this.blinkTick()
    }, BLINK_INTERVAL_MS)
    timer.unref()
    this.blinkTimer = timer
  }

  private blinkTick(): void {
    this.blinkOn = !this.blinkOn
    let anyLive = false
    for (const group of this.liveGroups) {
      if (group.phase === 'live') {
        anyLive = true
        this.invalidateGroup(group)
      }
    }
    for (const invalidate of this.blinkingRows.values()) {
      invalidate()
    }
    if (!anyLive && this.blinkingRows.size === 0) {
      this.stopBlink()
    }
  }

  private stopBlink(): void {
    if (this.blinkTimer !== undefined) {
      clearInterval(this.blinkTimer)
      this.blinkTimer = undefined
    }
  }
}
