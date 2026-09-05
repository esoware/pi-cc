import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'
import { stripTerminalSequences } from '@earendil-works/pi-tui'

import { ESC } from '../ansi.js'
import { isRecord, isUnknownArray } from '../guards.js'
import { shortPath } from '../paths.js'
import { renderGroupHeader } from './group-render.js'
import type { RowHandle, ToolGroup, ToolUi } from './groups.js'
import { PREVIEW_LINES, renderTruncatedContent, wrapWithHangingIndent } from './layout.js'
import {
  dimPaint,
  expandedBody,
  formatResultLine,
  formatRunningTime,
  HEADER_INDENT,
  paintRowLines,
  renderStatusDot,
  RESULT_INDENT,
} from './row.js'
import type { DotState, ToolRenderer, ToolRow } from './row.js'

const BUILTIN_SOURCE = 'builtin'
const SGR_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'gu')
const COLOR_PARAM_RE = /^(?:3\d|4\d|9[0-7]|10[0-7])$/u
const EXTENDED_COLOR_PARAMS = new Set(['38', '48'])
const EXTENDED_RGB_MODE = '2'
const EXTENDED_INDEXED_MODE = '5'
const RGB_PARAM_COUNT = 4
const INDEXED_PARAM_COUNT = 2

export type RenderMethod = (this: object, width: number) => string[]
export type MouseMethod = (this: object, event: unknown) => unknown

type ToolInfoList = ReturnType<ExtensionAPI['getAllTools']>

export interface ToolShellOptions {
  readonly getTheme: () => Theme
  readonly ui: ToolUi
  readonly renderers: ReadonlyMap<string, ToolRenderer>
  readonly getAllTools: () => ToolInfoList
  readonly press: RowPress
}

export class RowPress {
  private armed = false

  begin(): void {
    this.armed = false
  }

  arm(): void {
    this.armed = true
  }

  take(): boolean {
    const armed = this.armed
    this.armed = false
    return armed
  }
}

interface ShellResult {
  readonly content: readonly unknown[]
  readonly details?: unknown
  readonly isError: boolean
}

interface ShellHost {
  readonly toolName: string
  readonly toolCallId: string
  readonly cwd: string
  readonly args: unknown
  readonly isPartial: boolean
  readonly executionStarted: boolean
  readonly expanded: boolean
  readonly hideComponent: boolean
  readonly result: ShellResult | undefined
  readonly contentBox: { readonly children: readonly Component[] }
  readonly imageComponents: readonly Component[]
  readonly imageSpacers: readonly Component[]
  readonly ui: { readonly requestRender: () => void }
  readonly hasRendererDefinition: () => boolean
  readonly getRenderShell: () => unknown
  readonly getRenderContext: (lastComponent: Component | undefined) => unknown
  readonly getTextOutput: () => unknown
  readonly setExpanded: (expanded: boolean) => void
  readonly invalidate: () => void
}

interface PointerRow {
  readonly y: number
  readonly height: number
}

interface LeftPointer extends PointerRow {
  readonly type: 'press' | 'click'
  readonly button: 'left'
}

interface PointerMove extends PointerRow {
  readonly type: 'move'
}

interface BuiltinComponents {
  call: Component | undefined
  result: Component | undefined
}

interface BuiltinState {
  readonly owned: boolean
  readonly components: BuiltinComponents
}

interface RowRender {
  readonly host: ShellHost
  readonly theme: Theme
  readonly ui: ToolUi
  readonly expanded: boolean
}

interface BuiltinRender extends RowRender {
  readonly renderer: ToolRenderer
  readonly components: BuiltinComponents
}

const builtinStates = new WeakMap<object, BuiltinState>()
const hostRendered = new WeakSet<object>()

function stripColorParams(params: string): string {
  const parts = params === '' ? ['0'] : params.split(';')
  const kept: string[] = []
  let index = 0
  while (index < parts.length) {
    const part = parts[index] ?? ''
    if (EXTENDED_COLOR_PARAMS.has(part)) {
      const mode = parts[index + 1]
      let skip = 0
      if (mode === EXTENDED_RGB_MODE) {
        skip = RGB_PARAM_COUNT
      } else if (mode === EXTENDED_INDEXED_MODE) {
        skip = INDEXED_PARAM_COUNT
      }
      index += 1 + skip
    } else {
      if (!COLOR_PARAM_RE.test(part)) {
        kept.push(part)
      }
      index += 1
    }
  }
  return kept.join(';')
}

function stripColors(line: string): string {
  return line.replaceAll(SGR_RE, (sequence) => {
    const kept = stripColorParams(sequence.slice(2, -1))
    return kept === '' ? '' : `${ESC}[${kept}m`
  })
}

function isComponent(value: unknown): value is Component {
  return (
    isRecord(value) &&
    typeof value['render'] === 'function' &&
    typeof value['invalidate'] === 'function'
  )
}

function isComponentList(value: unknown): value is readonly Component[] {
  return isUnknownArray(value) && value.every((entry) => isComponent(entry))
}

function isResultShape(value: unknown): value is ShellResult | undefined {
  return (
    value === undefined ||
    (isRecord(value) && isUnknownArray(value['content']) && typeof value['isError'] === 'boolean')
  )
}

function isShellHost(value: unknown): value is ShellHost {
  if (!isRecord(value)) {
    return false
  }
  const contentBox = value['contentBox']
  const ui = value['ui']
  return (
    typeof value['toolName'] === 'string' &&
    typeof value['toolCallId'] === 'string' &&
    typeof value['cwd'] === 'string' &&
    typeof value['isPartial'] === 'boolean' &&
    typeof value['executionStarted'] === 'boolean' &&
    typeof value['expanded'] === 'boolean' &&
    typeof value['hideComponent'] === 'boolean' &&
    isResultShape(value['result']) &&
    isRecord(contentBox) &&
    isComponentList(contentBox['children']) &&
    isComponentList(value['imageComponents']) &&
    isComponentList(value['imageSpacers']) &&
    isRecord(ui) &&
    typeof ui['requestRender'] === 'function' &&
    typeof value['hasRendererDefinition'] === 'function' &&
    typeof value['getRenderShell'] === 'function' &&
    typeof value['getRenderContext'] === 'function' &&
    typeof value['getTextOutput'] === 'function' &&
    typeof value['setExpanded'] === 'function' &&
    typeof value['invalidate'] === 'function'
  )
}

function isPointerRow(value: unknown): value is PointerRow {
  return isRecord(value) && typeof value['y'] === 'number' && typeof value['height'] === 'number'
}

function isLeftPointer(value: unknown): value is LeftPointer {
  return (
    isPointerRow(value) &&
    isRecord(value) &&
    (value['type'] === 'press' || value['type'] === 'click') &&
    value['button'] === 'left'
  )
}

function isPointerMove(value: unknown): value is PointerMove {
  return isPointerRow(value) && isRecord(value) && value['type'] === 'move'
}

function inClickArea(host: ShellHost, event: PointerRow): boolean {
  return host.result !== undefined && event.y >= 1 && event.y < event.height
}

function isToolRow(value: unknown): value is ToolRow {
  if (!isRecord(value)) {
    return false
  }
  const lastComponent = value['lastComponent']
  return (
    typeof value['toolCallId'] === 'string' &&
    typeof value['cwd'] === 'string' &&
    typeof value['invalidate'] === 'function' &&
    isRecord(value['state']) &&
    typeof value['executionStarted'] === 'boolean' &&
    typeof value['argsComplete'] === 'boolean' &&
    typeof value['isPartial'] === 'boolean' &&
    typeof value['expanded'] === 'boolean' &&
    typeof value['showImages'] === 'boolean' &&
    typeof value['isError'] === 'boolean' &&
    (lastComponent === undefined || isComponent(lastComponent))
  )
}

function isBlankRow(line: string): boolean {
  return stripTerminalSequences(line).trim() === ''
}

function trimBlankRows(lines: readonly string[]): string[] {
  let start = 0
  let end = lines.length
  while (start < end && isBlankRow(lines[start] ?? '')) {
    start += 1
  }
  while (end > start && isBlankRow(lines[end - 1] ?? '')) {
    end -= 1
  }
  return lines.slice(start, end)
}

function ownsShell(host: ShellHost): boolean {
  return host.hasRendererDefinition() && host.getRenderShell() === 'self'
}

function shellDotState(host: ShellHost): DotState {
  if (host.result?.isError === true) {
    return 'error'
  }
  if (!host.isPartial) {
    return 'success'
  }
  return host.executionStarted ? 'busy' : 'idle'
}

function rowHandle(host: ShellHost): RowHandle {
  return {
    invalidate: () => {
      host.invalidate()
      host.ui.requestRender()
    },
    isExpanded: () => host.expanded,
    setExpanded: (expanded) => {
      host.setExpanded(expanded)
    },
  }
}

function renderChild(child: Component | undefined, width: number): string[] {
  return child === undefined ? [] : trimBlankRows(child.render(Math.max(1, width)))
}

function groupHeaderLines(target: RowRender, group: ToolGroup, width: number): string[] {
  const groups = target.ui.groups
  const host = target.host
  const hint = groups.hintTextFor(group, (path) => shortPath(host.cwd, path))
  return wrapWithHangingIndent(
    renderGroupHeader(target.theme, group, {
      hint,
      dotVisible: group.phase === 'live' ? groups.keepBlinking() : true,
      hovered: groups.isHovered(host.toolCallId),
      elapsedMs: groups.groupBashElapsedMsFor(group),
    }),
    width,
    RESULT_INDENT.length,
  )
}

function fallbackBody(target: RowRender, width: number): string[] {
  const raw = target.host.getTextOutput()
  const output = typeof raw === 'string' ? raw : ''
  if (output.trim() === '') {
    return []
  }
  const rendered = target.expanded
    ? expandedBody(target.theme, output, width)
    : renderTruncatedContent(target.theme, output, width, {
        rows: PREVIEW_LINES,
        paintLine: dimPaint(target.theme),
        expandHint: true,
      })
  return rendered === '' ? [] : rendered.split('\n')
}

function appendImages(host: ShellHost, lines: string[], width: number): string[] {
  for (const entry of host.imageComponents.entries()) {
    const spacer = host.imageSpacers[entry[0]]
    if (spacer !== undefined) {
      lines.push(...spacer.render(width))
    }
    lines.push(...entry[1].render(width))
  }
  return lines
}

function renderShellRow(target: RowRender, width: number): string[] {
  const host = target.host
  const theme = target.theme
  const state = shellDotState(host)
  const dotVisible =
    state === 'busy'
      ? target.ui.groups.keepRowBlinking(host.toolCallId, rowHandle(host).invalidate)
      : true
  const dot = renderStatusDot(theme, state, dotVisible)

  const hasRenderer = host.hasRendererDefinition()
  const children = hasRenderer ? host.contentBox.children : []
  const header = hasRenderer
    ? renderChild(children[0], width - HEADER_INDENT.length).map((line) => stripColors(line))
    : []
  if (header.length === 0) {
    header.push(theme.bold(host.toolName))
  }
  const bodyWidth = Math.max(1, width - RESULT_INDENT.length)
  const body = hasRenderer ? renderChild(children[1], bodyWidth) : fallbackBody(target, bodyWidth)

  const elapsed = formatRunningTime(theme, target.ui.groups.bashElapsedMsFor(host.toolCallId))
  const lines = wrapWithHangingIndent(
    `${dot} ${header[0] ?? ''}${elapsed}`,
    width,
    HEADER_INDENT.length,
  )
  for (const line of header.slice(1)) {
    lines.push(`${HEADER_INDENT}${line}`)
  }
  if (body.length > 0) {
    lines.push(formatResultLine(theme, body[0] ?? ''))
    for (const line of body.slice(1)) {
      lines.push(`${RESULT_INDENT}${line}`)
    }
  }
  return lines
}

function isBuiltinOwned(options: ToolShellOptions, name: string): boolean {
  try {
    return options
      .getAllTools()
      .some((tool) => tool.name === name && tool.sourceInfo.source === BUILTIN_SOURCE)
  } catch {
    return false
  }
}

function builtinState(host: ShellHost, options: ToolShellOptions): BuiltinState {
  const existing = builtinStates.get(host)
  if (existing !== undefined) {
    return existing
  }
  const state: BuiltinState = {
    owned: isBuiltinOwned(options, host.toolName),
    components: { call: undefined, result: undefined },
  }
  builtinStates.set(host, state)
  return state
}

function renderBuiltin(target: BuiltinRender, width: number): string[] | undefined {
  const host = target.host
  const renderer = target.renderer
  const components = target.components
  const theme = target.theme
  const expanded = target.expanded
  const callContext = host.getRenderContext(components.call)
  if (!isToolRow(callContext)) {
    return undefined
  }
  const call = renderer.renderCall(theme, { ...callContext, expanded })
  components.call = call
  const lines = [...call.render(width)]
  const result = host.result
  if (result !== undefined) {
    const resultContext = host.getRenderContext(components.result)
    if (!isToolRow(resultContext)) {
      return undefined
    }
    const component = renderer.renderResult(
      { content: result.content, details: result.details },
      { expanded, isPartial: host.isPartial },
      theme,
      { ...resultContext, expanded },
    )
    components.result = component
    lines.push(...component.render(width))
  }
  return lines
}

function renderBuiltinSafely(target: BuiltinRender, width: number): string[] | undefined {
  try {
    return renderBuiltin(target, width)
  } catch {
    return undefined
  }
}

export function createToolShellRender(
  options: ToolShellOptions,
  original: RenderMethod,
): RenderMethod {
  return function render(this: object, width: number): string[] {
    if (!isShellHost(this)) {
      return original.call(this, width)
    }
    hostRendered.delete(this)
    const ui = options.ui
    const theme = options.getTheme()
    ui.groups.trackRow(this.toolCallId, rowHandle(this))
    if (this.hideComponent) {
      return []
    }
    const membership = ui.groups.membership(this.toolCallId)
    const expanded = membership?.expanded ?? this.expanded
    const target: RowRender = { host: this, theme, ui, expanded }
    if (membership !== undefined && !membership.expanded) {
      return membership.isLeader ? ['', ...groupHeaderLines(target, membership.group, width)] : []
    }

    let lines: string[] | undefined
    const renderer = options.renderers.get(this.toolName)
    const state = renderer === undefined ? undefined : builtinState(this, options)
    if (renderer !== undefined && state?.owned === true) {
      lines = renderBuiltinSafely({ ...target, renderer, components: state.components }, width)
    }
    if (lines === undefined) {
      if (ownsShell(this)) {
        hostRendered.add(this)
        return original.call(this, width)
      }
      lines = renderShellRow(target, width)
    }
    if (lines.length === 0) {
      return appendImages(this, [], width)
    }
    if (!expanded) {
      return appendImages(this, ['', ...lines], width)
    }
    const dotState = shellDotState(this)
    const separator =
      membership !== undefined && !membership.isLeader
        ? paintRowLines(theme, dotState, [''], width)
        : ['']
    return appendImages(
      this,
      [...separator, ...paintRowLines(theme, dotState, lines, width)],
      width,
    )
  }
}

export function createToolShellMouse(
  options: ToolShellOptions,
  original: MouseMethod,
): MouseMethod {
  return function handleMouse(this: object, event: unknown): unknown {
    if (!isShellHost(this) || hostRendered.has(this)) {
      return original.call(this, event)
    }
    const groups = options.ui.groups
    if (isPointerMove(event)) {
      const membership = groups.membership(this.toolCallId)
      if (event.y < 1 || membership === undefined || membership.expanded || !membership.isLeader) {
        return original.call(this, event)
      }
      return { handled: true, render: groups.hoverRow(this.toolCallId) }
    }
    if (!isLeftPointer(event)) {
      return original.call(this, event)
    }
    if (!inClickArea(this, event)) {
      return undefined
    }
    if (event.type === 'press') {
      options.press.arm()
      return undefined
    }
    const membership = groups.membership(this.toolCallId)
    if (membership === undefined) {
      this.setExpanded(!this.expanded)
    } else {
      groups.setGroupExpanded(this.toolCallId, !membership.expanded)
    }
    return { handled: true }
  }
}
