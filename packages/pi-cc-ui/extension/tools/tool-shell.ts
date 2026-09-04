import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'
import { stripTerminalSequences } from '@earendil-works/pi-tui'

import { ESC } from '../ansi.js'
import { isRecord, isUnknownArray } from '../guards.js'
import { dimPaint, groupRowText, previewLineLimit } from './group-row.js'
import type { ToolUi } from './group-row.js'
import { renderTruncatedContent, wrapWithHangingIndent } from './layout.js'
import { formatResultLine, HEADER_INDENT, renderStatusDot, RESULT_INDENT } from './row.js'
import type { DotState, ToolRenderer, ToolRow } from './row.js'

const EXPANDED_FALLBACK_ROWS = 2000
const BUILTIN_SOURCE = 'builtin'
const SGR_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'gu')
const COLOR_PARAM_RE = /^(?:3\d|4\d|9[0-7]|10[0-7])$/u
const EXTENDED_COLOR_PARAMS = new Set(['38', '48'])
const EXTENDED_RGB_MODE = '2'
const EXTENDED_INDEXED_MODE = '5'
const RGB_PARAM_COUNT = 4
const INDEXED_PARAM_COUNT = 2

export type RenderMethod = (this: object, width: number) => string[]

type ToolInfoList = ReturnType<ExtensionAPI['getAllTools']>

export interface ToolShellOptions {
  readonly getTheme: () => Theme
  readonly ui: ToolUi
  readonly renderers: ReadonlyMap<string, ToolRenderer>
  readonly getAllTools: () => ToolInfoList
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
  readonly invalidate: () => void
}

interface BuiltinComponents {
  call: Component | undefined
  result: Component | undefined
}

interface BuiltinState {
  readonly owned: boolean
  readonly components: BuiltinComponents
}

interface BuiltinRender {
  readonly host: ShellHost
  readonly renderer: ToolRenderer
  readonly components: BuiltinComponents
  readonly theme: Theme
}

const builtinStates = new WeakMap<object, BuiltinState>()

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
    typeof value['invalidate'] === 'function'
  )
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

function shellDotState(host: ShellHost): DotState {
  if (host.result?.isError === true) {
    return 'error'
  }
  if (!host.isPartial) {
    return 'success'
  }
  return host.executionStarted ? 'busy' : 'idle'
}

function renderChild(child: Component | undefined, width: number): string[] {
  return child === undefined ? [] : trimBlankRows(child.render(Math.max(1, width)))
}

function fallbackBody(theme: Theme, ui: ToolUi, host: ShellHost, width: number): string[] {
  const raw = host.getTextOutput()
  const output = typeof raw === 'string' ? raw : ''
  if (output.trim() === '') {
    return []
  }
  const rendered = renderTruncatedContent(theme, output, width, {
    rows: host.expanded ? EXPANDED_FALLBACK_ROWS : previewLineLimit(ui),
    paintLine: dimPaint(theme),
    expandHint: !host.expanded,
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

function renderShell(host: ShellHost, theme: Theme, ui: ToolUi, width: number): string[] {
  if (host.hideComponent) {
    return []
  }
  function invalidate(): void {
    host.invalidate()
    host.ui.requestRender()
  }
  const grouped = groupRowText(ui, theme, {
    toolCallId: host.toolCallId,
    cwd: host.cwd,
    expanded: host.expanded,
    invalidate,
  })
  if (grouped?.kind === 'hidden') {
    return []
  }
  if (grouped !== undefined) {
    return ['', ...wrapWithHangingIndent(grouped.text, width, RESULT_INDENT.length)]
  }

  const state = shellDotState(host)
  const dotVisible =
    state === 'busy' ? ui.groups.keepRowBlinking(host.toolCallId, invalidate) : true
  const dot = renderStatusDot(theme, state, dotVisible)

  const hasRenderer = host.hasRendererDefinition()
  const children = hasRenderer ? host.contentBox.children : []
  const call = children[0]
  const result = children[1]
  const header = hasRenderer
    ? renderChild(call, width - HEADER_INDENT.length).map((line) => stripColors(line))
    : []
  if (header.length === 0) {
    header.push(theme.bold(host.toolName))
  }
  const body = hasRenderer
    ? renderChild(result, width - RESULT_INDENT.length)
    : fallbackBody(theme, ui, host, Math.max(1, width - RESULT_INDENT.length))

  const lines = ['', `${dot} ${header[0] ?? ''}`]
  for (const line of header.slice(1)) {
    lines.push(`${HEADER_INDENT}${line}`)
  }
  if (body.length > 0) {
    lines.push(formatResultLine(theme, body[0] ?? ''))
    for (const line of body.slice(1)) {
      lines.push(`${RESULT_INDENT}${line}`)
    }
  }
  return appendImages(host, lines, width)
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
  const callContext = host.getRenderContext(components.call)
  if (!isToolRow(callContext)) {
    return undefined
  }
  const call = renderer.renderCall(theme, callContext)
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
      { expanded: host.expanded, isPartial: host.isPartial },
      theme,
      resultContext,
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
    const renderer = options.renderers.get(this.toolName)
    if (renderer !== undefined) {
      const state = builtinState(this, options)
      if (state.owned) {
        const lines = renderBuiltinSafely(
          {
            host: this,
            renderer,
            components: state.components,
            theme: options.getTheme(),
          },
          width,
        )
        if (lines !== undefined) {
          return appendImages(this, lines.length > 0 ? ['', ...lines] : [], width)
        }
      }
    }
    if (this.hasRendererDefinition() && this.getRenderShell() === 'self') {
      return original.call(this, width)
    }
    return renderShell(this, options.getTheme(), options.ui, width)
  }
}
