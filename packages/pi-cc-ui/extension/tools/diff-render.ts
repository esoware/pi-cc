import type { Theme } from '@earendil-works/pi-coding-agent'
import { visibleWidth } from '@earendil-works/pi-tui'
import { diffWordsWithSpace } from 'diff'

import { BOLD, DIM, ESC, ITALIC, RESET } from '../ansi.js'
import { pluralize } from '../format.js'
import { maxLineNumber } from './diff-model.js'
import type { DiffLine, ParsedDiff } from './diff-model.js'
import { diffSgr } from './diff-palette.js'
import type { DiffSgr } from './diff-palette.js'
import { expandKeyHint } from './layout.js'

export const MAX_PREVIEW_LINES = 60

const CHANGE_RATIO_THRESHOLD = 0.4
const DIFF_GUTTER_GAP = 2
const LISTING_GUTTER_GAP = 1
const TAB_SPACES = '  '

const SGR_PARAMS_RE = new RegExp(`${ESC}\\[(?<params>[0-9;]*)m`, 'gu')

export interface DiffRenderOptions {
  readonly maxLines: number
  readonly expandHint: boolean
}

export interface ListingRenderOptions {
  readonly hiddenLines: number
  readonly expandHint: boolean
}

interface Cell {
  readonly text: string
  readonly width: number
}

interface WordBodies {
  readonly old: string
  readonly new: string
}

interface GutterRow {
  readonly gutter: string
  readonly continuation: string
  readonly body: string
  readonly bg: string
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function expandTabs(text: string): string {
  return text.replaceAll('\t', TAB_SPACES)
}

function toCells(text: string): Cell[] {
  const cells: Cell[] = []
  let index = 0
  let runStart = 0

  function flushPlain(end: number): void {
    if (end <= runStart) {
      return
    }
    for (const part of graphemeSegmenter.segment(text.slice(runStart, end))) {
      cells.push({ text: part.segment, width: visibleWidth(part.segment) })
    }
  }

  while (index < text.length) {
    const end = text[index] === ESC ? text.indexOf('m', index) : -1
    if (end === -1) {
      index += 1
    } else {
      flushPlain(index)
      cells.push({ text: text.slice(index, end + 1), width: 0 })
      index = end + 1
      runStart = index
    }
  }
  flushPlain(text.length)
  return cells
}

function ansiState(text: string): string {
  let foreground = ''
  let background = ''
  let isBold = false
  let isDim = false
  let isItalic = false
  for (const match of text.matchAll(SGR_PARAMS_RE)) {
    const sequence = match[0]
    const params = match.groups?.['params'] ?? ''
    if (params === '0') {
      foreground = ''
      background = ''
      isBold = false
      isDim = false
      isItalic = false
    } else if (params === '39') {
      foreground = ''
    } else if (params === '49') {
      background = ''
    } else if (params === '1') {
      isBold = true
    } else if (params === '2') {
      isDim = true
    } else if (params === '22') {
      isBold = false
      isDim = false
    } else if (params === '3') {
      isItalic = true
    } else if (params === '23') {
      isItalic = false
    } else if (params.startsWith('38;')) {
      foreground = sequence
    } else if (params.startsWith('48;')) {
      background = sequence
    }
  }
  return (
    background + foreground + (isBold ? BOLD : '') + (isDim ? DIM : '') + (isItalic ? ITALIC : '')
  )
}

function wrapAnsi(text: string, width: number, fillBg: string): string[] {
  const safeWidth = Math.max(1, width)
  const rows: string[] = []
  let row = ''
  let visible = 0

  function finishRow(): void {
    const pad = fillBg === '' ? '' : `${fillBg}${' '.repeat(safeWidth - visible)}`
    rows.push(row + pad)
  }

  for (const cell of toCells(text)) {
    if (cell.width > 0 && visible + cell.width > safeWidth) {
      const state = ansiState(row)
      finishRow()
      row = state
      visible = 0
    }
    row += cell.text
    visible += cell.width
  }
  if (rows.length === 0 || visible > 0) {
    finishRow()
  }
  return rows
}

function padNumber(value: number | undefined, width: number): string {
  return value === undefined ? ' '.repeat(width) : String(value).padStart(width)
}

function emitGutterRow(out: string[], row: GutterRow, codeWidth: number): void {
  const rows = wrapAnsi(expandTabs(row.body), codeWidth, row.bg)
  out.push(`${row.gutter}${rows[0] ?? ''}${RESET}`)
  for (const wrapped of rows.slice(1)) {
    out.push(`${row.continuation}${wrapped}${RESET}`)
  }
}

function formatMoreLinesHint(theme: Theme, hidden: number, expandHint: boolean): string {
  const count = theme.fg('dim', `… +${hidden} ${pluralize(hidden, 'line')}`)
  return expandHint ? `${count} ${theme.italic(theme.fg('dim', `(${expandKeyHint()})`))}` : count
}

function wordBodies(sgr: DiffSgr, oldText: string, newText: string): WordBodies | undefined {
  if (oldText === '' && newText === '') {
    return undefined
  }
  let changed = 0
  let oldOut = ''
  let newOut = ''
  for (const part of diffWordsWithSpace(oldText, newText)) {
    if (part.removed) {
      changed += part.value.length
      oldOut += `${sgr.removedWordBg}${part.value}${sgr.removedBg}`
    } else if (part.added) {
      changed += part.value.length
      newOut += `${sgr.addedWordBg}${part.value}${sgr.addedBg}`
    } else {
      oldOut += part.value
      newOut += part.value
    }
  }
  const ratio = changed / (oldText.length + newText.length)
  return ratio > CHANGE_RATIO_THRESHOLD ? undefined : { old: oldOut, new: newOut }
}

function collectRun(lines: readonly DiffLine[], start: number, type: DiffLine['type']): DiffLine[] {
  const run: DiffLine[] = []
  let index = start
  while (index < lines.length) {
    const candidate = lines[index]
    if (candidate?.type !== type) {
      break
    }
    run.push(candidate)
    index += 1
  }
  return run
}

export function formatDiffStat(theme: Theme, added: number, removed: number): string {
  const parts: string[] = []
  if (added > 0) {
    parts.push(`Added ${theme.bold(String(added))} ${pluralize(added, 'line')}`)
  }
  if (removed > 0) {
    const lead = added > 0 ? ', r' : 'R'
    parts.push(`${lead}emoved ${theme.bold(String(removed))} ${pluralize(removed, 'line')}`)
  }
  return parts.join('')
}

export function renderDiffBody(
  theme: Theme,
  diff: ParsedDiff,
  width: number,
  options: DiffRenderOptions,
): string[] {
  if (diff.lines.length === 0) {
    return []
  }
  const sgr = diffSgr(theme)
  const visible = diff.lines.slice(0, options.maxLines)
  const numberWidth = Math.max(1, String(maxLineNumber(visible)).length)
  const codeWidth = Math.max(1, width - (numberWidth + DIFF_GUTTER_GAP))
  const blankGutter = ' '.repeat(numberWidth + DIFF_GUTTER_GAP)
  const out: string[] = []

  function emitContext(line: DiffLine): void {
    emitGutterRow(
      out,
      {
        gutter: `${sgr.lineNumberFg}${padNumber(line.newNumber, numberWidth)}${RESET}  `,
        continuation: blankGutter,
        body: line.content,
        bg: '',
      },
      codeWidth,
    )
  }

  function emitChange(line: DiffLine, body: string): void {
    const isRemoval = line.type === 'del'
    const bg = isRemoval ? sgr.removedBg : sgr.addedBg
    const number = padNumber(isRemoval ? line.oldNumber : line.newNumber, numberWidth)
    emitGutterRow(
      out,
      {
        gutter: `${bg}${number} ${isRemoval ? '-' : '+'}`,
        continuation: `${bg}${blankGutter}`,
        body: `${bg}${body}`,
        bg,
      },
      codeWidth,
    )
  }

  let index = 0
  while (index < visible.length) {
    const line = visible[index]
    if (line === undefined) {
      break
    }
    if (line.type === 'sep') {
      out.push(theme.fg('dim', '...'))
      index += 1
    } else if (line.type === 'ctx') {
      emitContext(line)
      index += 1
    } else {
      const removals = collectRun(visible, index, 'del')
      index += removals.length
      const additions = collectRun(visible, index, 'add')
      index += additions.length
      const paired = removals.map((removal, pair) => {
        const addition = additions[pair]
        return addition === undefined
          ? undefined
          : wordBodies(sgr, removal.content, addition.content)
      })
      for (const entry of removals.entries()) {
        emitChange(entry[1], paired[entry[0]]?.old ?? entry[1].content)
      }
      for (const entry of additions.entries()) {
        emitChange(entry[1], paired[entry[0]]?.new ?? entry[1].content)
      }
    }
  }

  if (diff.lines.length > visible.length) {
    out.push(formatMoreLinesHint(theme, diff.lines.length - visible.length, options.expandHint))
  }
  return out
}

export function renderNumberedListing(
  theme: Theme,
  lines: readonly string[],
  width: number,
  options: ListingRenderOptions,
): string[] {
  const sgr = diffSgr(theme)
  const numberWidth = Math.max(1, String(lines.length).length)
  const codeWidth = Math.max(1, width - (numberWidth + LISTING_GUTTER_GAP))
  const blankGutter = ' '.repeat(numberWidth + LISTING_GUTTER_GAP)
  const out: string[] = []
  for (const entry of lines.entries()) {
    emitGutterRow(
      out,
      {
        gutter: `${sgr.lineNumberFg}${padNumber(entry[0] + 1, numberWidth)}${RESET} `,
        continuation: blankGutter,
        body: entry[1],
        bg: '',
      },
      codeWidth,
    )
  }
  if (options.hiddenLines > 0) {
    out.push(formatMoreLinesHint(theme, options.hiddenLines, options.expandHint))
  }
  return out
}
