import type { Theme, ThemeColor, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import { themeName } from '../ansi.js'
import { cacheKey, KeyedCache } from '../cache.js'
import { clampWidth, indentContinuationLines, wrapWithHangingIndent } from './layout.js'
import { toolResultText } from './output.js'

export const RESULT_LEAD = '  ⎿  '
export const RESULT_INDENT = ' '.repeat(RESULT_LEAD.length)
const RESULT_COLUMN = RESULT_INDENT.length
export const HEADER_INDENT = '  '
export const STATUS_DOT = process.platform === 'darwin' ? '⏺' : '●'

const MIN_RESULT_CONTENT_WIDTH = 10
const MIN_DIFF_CARD_WIDTH = 20

interface ToolRowState {
  liveLineCount?: number
}

type RenderContext = Parameters<NonNullable<ToolDefinition['renderCall']>>[2]

export interface ToolRow extends Omit<RenderContext, 'args' | 'state'> {
  readonly args: unknown
  readonly state: ToolRowState
}

export interface ToolResultView {
  readonly content: readonly unknown[]
  readonly details: unknown
}

export interface ResultRenderOptions {
  readonly expanded: boolean
  readonly isPartial: boolean
}

export interface ToolRenderer {
  readonly renderCall: (theme: Theme, row: ToolRow) => Component
  readonly renderResult: (
    result: ToolResultView,
    options: ResultRenderOptions,
    theme: Theme,
    row: ToolRow,
  ) => Component
}

export type DotState = 'idle' | 'busy' | 'success' | 'error'

function resultContentWidth(width: number): number {
  return clampWidth(width - RESULT_COLUMN, MIN_RESULT_CONTENT_WIDTH)
}

export function renderStatusDot(theme: Theme, state: DotState, dotVisible: boolean): string {
  switch (state) {
    case 'success': {
      return theme.fg('success', STATUS_DOT)
    }
    case 'error': {
      return theme.fg('error', STATUS_DOT)
    }
    case 'busy': {
      return dotVisible ? theme.fg('dim', STATUS_DOT) : ' '
    }
    case 'idle': {
      return theme.fg('dim', STATUS_DOT)
    }
  }
}

export function formatToolHeader(
  theme: Theme,
  label: string,
  summary: string,
  dot: string,
): string {
  const name = theme.bold(label)
  return `${dot} ${summary === '' ? name : `${name}(${summary})`}`
}

export function formatResultLine(theme: Theme, text: string): string {
  return `${theme.fg('dim', RESULT_LEAD)}${text}`
}

export function formatResultStatus(theme: Theme, color: ThemeColor, text: string): string {
  return formatResultLine(theme, theme.fg(color, text))
}

export function formatResultError(theme: Theme, result: unknown, fallback: string): string {
  const text = toolResultText(result)
  return formatResultStatus(theme, 'error', text === '' ? fallback : text)
}

class RowLinesComponent implements Component {
  private readonly lines = new KeyedCache<string[]>()
  private key = ''
  private build: (width: number) => string[] = () => []

  setContent(key: string, build: (width: number) => string[]): void {
    if (this.key !== key) {
      this.key = key
      this.lines.clear()
    }
    this.build = build
  }

  render(width: number): string[] {
    return this.lines.get(String(width), () => this.build(width))
  }

  invalidate(): void {
    this.lines.clear()
  }
}

function reuseRowLines(row: ToolRow): RowLinesComponent {
  const lastComponent = row.lastComponent
  return lastComponent instanceof RowLinesComponent ? lastComponent : new RowLinesComponent()
}

export function renderRowHeader(row: ToolRow, text: string): Component {
  const component = reuseRowLines(row)
  component.setContent(cacheKey('header', text), (width) =>
    wrapWithHangingIndent(
      indentContinuationLines(text, HEADER_INDENT),
      width,
      HEADER_INDENT.length,
    ),
  )
  return component
}

export function renderRowText(row: ToolRow, text: string): Component {
  const component = reuseRowLines(row)
  component.setContent(cacheKey('text', text), (width) =>
    text === ''
      ? []
      : wrapWithHangingIndent(indentContinuationLines(text, RESULT_INDENT), width, RESULT_COLUMN),
  )
  return component
}

export function renderRowBody(
  row: ToolRow,
  theme: Theme,
  key: string,
  build: (contentWidth: number) => string,
): Component {
  const lead = theme.fg('dim', RESULT_LEAD)
  const component = reuseRowLines(row)
  component.setContent(cacheKey('body', themeName(theme), key), (width) => {
    const body = build(resultContentWidth(width))
    if (body === '') {
      return []
    }
    const indented = indentContinuationLines(body, RESULT_INDENT)
    return wrapWithHangingIndent(`${lead}${indented}`, width, RESULT_COLUMN)
  })
  return component
}

export function renderDiffCard(
  row: ToolRow,
  theme: Theme,
  key: string,
  build: (width: number) => string[],
): Component {
  const component = reuseRowLines(row)
  component.setContent(cacheKey('diff', themeName(theme), key), (width) => {
    const available = clampWidth(width)
    return build(Math.max(MIN_DIFF_CARD_WIDTH, available)).map((line) =>
      visibleWidth(line) <= available ? line : truncateToWidth(line, available, ''),
    )
  })
  return component
}
