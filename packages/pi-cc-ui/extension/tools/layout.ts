import type { Theme } from '@earendil-works/pi-coding-agent'
import { keyText } from '@earendil-works/pi-coding-agent'
import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from '@earendil-works/pi-tui'

import type { PaintText } from '../ansi.js'

const MAX_CHARS_PER_COLUMN = 4
const TRAILING_WHITESPACE_RE = /\s+$/u
const TRAILING_SPACE_RE = /[ \t]+$/u

interface TruncatedContentOptions {
  readonly rows: number
  readonly paintLine: PaintText
  readonly expandHint: boolean
}

interface TailRowsOptions {
  readonly rows: number
  readonly paintLine: PaintText
}

interface CountedLines {
  readonly lines: string[]
  readonly total: number
}

interface VisualHead {
  readonly lines: string[]
  readonly remaining: number
}

export function clampWidth(width: number, minimum = 1): number {
  return Math.max(minimum, Math.floor(width))
}

export function expandKeyHint(): string {
  return `${keyText('app.tools.expand')} to expand`
}

export function indentContinuationLines(text: string, indent: string): string {
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? line : `${indent}${line}`))
    .join('\n')
}

export function wrapWithHangingIndent(text: string, width: number, indent: number): string[] {
  const maxWidth = clampWidth(width)
  const pad = ' '.repeat(indent)
  const contentWidth = clampWidth(maxWidth - indent)
  const wrapped: string[] = []
  for (const logical of text.split('\n')) {
    if (visibleWidth(logical) <= maxWidth) {
      wrapped.push(logical)
    } else {
      const gutter = sliceByColumn(logical, 0, indent)
      const content = sliceByColumn(logical, indent, Number.MAX_SAFE_INTEGER)
      const rows = wrapTextWithAnsi(content, contentWidth)
      wrapped.push(`${gutter}${rows[0] ?? ''}`)
      for (const row of rows.slice(1)) {
        wrapped.push(`${pad}${row}`)
      }
    }
  }
  return wrapped.map((line) =>
    visibleWidth(line) <= maxWidth ? line : truncateToWidth(line, maxWidth, ''),
  )
}

export function nonEmptyLines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '')
}

export function tailNonEmptyLines(text: string, limit: number): CountedLines {
  const keep = Math.max(0, Math.floor(limit))
  const lines: string[] = []
  let total = 0
  for (const line of text.split('\n')) {
    if (line.trim() !== '') {
      total += 1
      if (keep > 0) {
        if (lines.length === keep) {
          lines.shift()
        }
        lines.push(line)
      }
    }
  }
  return { lines, total }
}

function trimTrailingSpace(text: string): string {
  return text.replace(TRAILING_SPACE_RE, '')
}

function headVisualRows(text: string, width: number, rows: number): VisualHead {
  const wrapped: string[] = []
  for (const line of text.split('\n')) {
    const lineWidth = visibleWidth(line)
    if (lineWidth <= width) {
      wrapped.push(trimTrailingSpace(line))
    } else {
      for (let column = 0; column < lineWidth; column += width) {
        wrapped.push(trimTrailingSpace(sliceByColumn(line, column, width)))
        if (wrapped.length > rows + 1) {
          break
        }
      }
    }
    if (wrapped.length > rows + 1) {
      break
    }
  }
  const remaining = wrapped.length - rows
  if (remaining === 1) {
    return { lines: wrapped.slice(0, rows + 1), remaining: 0 }
  }
  return { lines: wrapped.slice(0, rows), remaining: Math.max(0, remaining) }
}

export function renderTruncatedContent(
  theme: Theme,
  text: string,
  width: number,
  options: TruncatedContentOptions,
): string {
  const trimmed = text.replace(TRAILING_WHITESPACE_RE, '')
  if (trimmed === '') {
    return ''
  }
  const rows = options.rows
  const paintLine = options.paintLine
  const contentWidth = clampWidth(width)
  const maxChars = Math.max(1, rows) * contentWidth * MAX_CHARS_PER_COLUMN
  const preTruncated = trimmed.length > maxChars
  const head = headVisualRows(
    preTruncated ? trimmed.slice(0, maxChars) : trimmed,
    contentWidth,
    rows,
  )
  const hidden = preTruncated
    ? Math.max(head.remaining, Math.ceil(trimmed.length / contentWidth) - rows)
    : head.remaining

  const body = head.lines.map((line) => paintLine(line === '' ? ' ' : line)).join('\n')
  if (hidden === 0) {
    return body
  }
  const hint = options.expandHint ? ` ${theme.italic(`(${expandKeyHint()})`)}` : ''
  return `${body}\n${theme.fg('dim', `… +${hidden} lines`)}${hint}`
}

export function renderTailRows(
  lines: readonly string[],
  width: number,
  options: TailRowsOptions,
): string {
  const rows = options.rows
  const paintLine = options.paintLine
  const contentWidth = clampWidth(width)
  const candidates = lines.slice(-rows)
  const tail: string[] = []
  for (let index = candidates.length - 1; index >= 0 && tail.length < rows; index--) {
    const line = candidates[index] ?? ''
    const lineWidth = visibleWidth(line)
    if (lineWidth <= contentWidth) {
      tail.unshift(line)
    } else {
      const chunkCount = Math.ceil(lineWidth / contentWidth)
      const firstChunk = Math.max(0, chunkCount - (rows - tail.length))
      const chunks: string[] = []
      for (let chunk = firstChunk; chunk < chunkCount; chunk++) {
        chunks.push(sliceByColumn(line, chunk * contentWidth, contentWidth))
      }
      tail.unshift(...chunks)
    }
  }
  return tail
    .slice(-rows)
    .map((line) => paintLine(line === '' ? ' ' : line))
    .join('\n')
}
