import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

import type {
  BashToolCallEvent,
  BashToolInput,
  EditToolCallEvent,
  EditToolDetails,
  EditToolInput,
  ExtensionAPI,
  FindToolCallEvent,
  FindToolInput,
  GrepToolCallEvent,
  GrepToolInput,
  LsToolCallEvent,
  LsToolInput,
  PowerShellToolCallEvent,
  ReadToolCallEvent,
  ReadToolDetails,
  ReadToolInput,
  Theme,
  TruncationResult,
  WriteToolCallEvent,
  WriteToolInput,
} from '@earendil-works/pi-coding-agent'
import { getLanguageFromPath, highlightCode } from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import { cacheKey } from '../cache.js'
import { collapseWhitespace, pluralize, truncateChars } from '../format.js'
import { isRecord, isUnknownArray } from '../guards.js'
import { shortPath } from '../paths.js'
import type { Settings } from '../settings.js'
import { parseDiff, parseUnifiedPatch } from './diff-model.js'
import type { ParsedDiff } from './diff-model.js'
import {
  formatDiffStat,
  MAX_PREVIEW_LINES,
  MAX_RENDER_LINES,
  renderDiffBody,
  renderNumberedListing,
} from './diff-render.js'
import { dimPaint, groupRowText, previewLineLimit } from './group-row.js'
import type { ToolUi } from './group-row.js'
import type { ToolGroups } from './groups.js'
import {
  nonEmptyLines,
  renderTailRows,
  renderTruncatedContent,
  tailNonEmptyLines,
} from './layout.js'
import {
  countGrepFiles,
  countLines,
  lastExitCode,
  listedItems,
  sanitizeToolText,
  stripReadContinuationNotice,
  toolResultHasImage,
  toolResultText,
} from './output.js'
import {
  formatResultError,
  formatResultLine,
  formatResultStatus,
  formatToolHeader,
  renderDiffCard,
  renderRowBody,
  renderRowHeader,
  renderRowText,
  renderStatusDot,
  RESULT_INDENT,
} from './row.js'
import type { DotState, ToolRenderer, ToolRow } from './row.js'

const MAX_COMMAND_DISPLAY_LINES = 2
const MAX_COMMAND_DISPLAY_CHARS = 160
const MAX_FIND_PATTERN_CHARS = 40
const WRITE_PREVIEW_LINES = 10
const MAX_DIFF_FILE_BYTES = 1_048_576
const MAX_WRITE_SNAPSHOTS = 64
const STREAM_PREVIEW_ROWS = 5
const IMAGE_RESULT_NOTICE = '[Image data detected and sent to Claude]'
const BASH_LABEL = 'Bash'
const POWERSHELL_LABEL = 'PowerShell'

type BuiltinToolName =
  | BashToolCallEvent['toolName']
  | EditToolCallEvent['toolName']
  | FindToolCallEvent['toolName']
  | GrepToolCallEvent['toolName']
  | LsToolCallEvent['toolName']
  | PowerShellToolCallEvent['toolName']
  | ReadToolCallEvent['toolName']
  | WriteToolCallEvent['toolName']

const WRITE_TOOL_NAME: WriteToolCallEvent['toolName'] = 'write'

const EDIT_ARRAY_KEY: keyof EditToolInput = 'edits'
const EDIT_PATCH_KEY: keyof EditToolDetails = 'patch'
const READ_TRUNCATION_KEY: keyof ReadToolDetails = 'truncation'
const TRUNCATED_KEY: keyof TruncationResult = 'truncated'
const TOTAL_LINES_KEY: keyof TruncationResult = 'totalLines'

type WriteSnapshot =
  | { readonly kind: 'created' }
  | { readonly kind: 'overwritten'; readonly oldContent: string }
  | { readonly kind: 'unreadable' }

interface DiffCardOptions {
  readonly lead: string
  readonly maxLines: number
  readonly expandHint: boolean
}

interface WriteListingOptions extends DiffCardOptions {
  readonly language: string | undefined
}

type EditPair = EditToolInput['edits'][number]

type ReadTruncation = Pick<TruncationResult, 'truncated' | 'totalLines'>

type StringArgKey<TInput> = {
  [K in keyof TInput]-?: string extends TInput[K] ? K : never
}[keyof TInput] &
  string

function argString<TInput>(args: unknown, key: StringArgKey<TInput>): string {
  if (!isRecord(args)) {
    return ''
  }
  const value = args[key]
  return typeof value === 'string' ? value : ''
}

function argEdits(args: unknown): EditPair[] {
  if (!isRecord(args)) {
    return []
  }
  const raw = args[EDIT_ARRAY_KEY]
  if (!isUnknownArray(raw)) {
    return []
  }
  const edits: EditPair[] = []
  for (const edit of raw) {
    if (
      isRecord(edit) &&
      typeof edit['oldText'] === 'string' &&
      typeof edit['newText'] === 'string'
    ) {
      edits.push({
        oldText: sanitizeToolText(edit['oldText']),
        newText: sanitizeToolText(edit['newText']),
      })
    }
  }
  return edits
}

function readTruncation(details: unknown): ReadTruncation | undefined {
  if (!isRecord(details)) {
    return undefined
  }
  const truncation = details[READ_TRUNCATION_KEY]
  if (!isRecord(truncation)) {
    return undefined
  }
  const truncated = truncation[TRUNCATED_KEY]
  const totalLines = truncation[TOTAL_LINES_KEY]
  if (typeof truncated !== 'boolean' || typeof totalLines !== 'number') {
    return undefined
  }
  return { truncated, totalLines }
}

function editPatch(details: unknown): EditToolDetails['patch'] | undefined {
  if (!isRecord(details)) {
    return undefined
  }
  const patch = details[EDIT_PATCH_KEY]
  return typeof patch === 'string' ? sanitizeToolText(patch) : undefined
}

function truncateCommand(command: string): string {
  const lines = command.split('\n')
  const needsLineTruncation = lines.length > MAX_COMMAND_DISPLAY_LINES
  if (!needsLineTruncation && visibleWidth(command) <= MAX_COMMAND_DISPLAY_CHARS) {
    return command
  }
  const truncated = (
    needsLineTruncation ? lines.slice(0, MAX_COMMAND_DISPLAY_LINES).join('\n') : command
  ).trim()
  return visibleWidth(truncated) > MAX_COMMAND_DISPLAY_CHARS
    ? truncateToWidth(truncated, MAX_COMMAND_DISPLAY_CHARS, '…')
    : `${truncated}…`
}

function snapshotWriteTarget(cwd: string, path: string): WriteSnapshot {
  const fullPath = path === '' ? '' : resolve(cwd, path)
  if (fullPath === '' || !existsSync(fullPath)) {
    return { kind: 'created' }
  }
  try {
    return statSync(fullPath).size > MAX_DIFF_FILE_BYTES
      ? { kind: 'unreadable' }
      : { kind: 'overwritten', oldContent: sanitizeToolText(readFileSync(fullPath, 'utf8')) }
  } catch {
    return { kind: 'overwritten', oldContent: '' }
  }
}

function rowDotState(row: ToolRow): DotState {
  if (row.isError) {
    return 'error'
  }
  if (!row.isPartial) {
    return 'success'
  }
  return row.executionStarted ? 'busy' : 'idle'
}

function renderRowDot(ui: ToolUi, theme: Theme, row: ToolRow): string {
  const state = rowDotState(row)
  const dotVisible =
    state === 'busy' ? ui.groups.keepRowBlinking(row.toolCallId, row.invalidate) : true
  return renderStatusDot(theme, state, dotVisible)
}

function renderGroupedCall(ui: ToolUi, theme: Theme, row: ToolRow): Component | undefined {
  const grouped = groupRowText(ui, theme, row)
  if (grouped === undefined) {
    return undefined
  }
  return renderRowText(row, grouped.kind === 'hidden' ? '' : grouped.text)
}

function renderGroupedResult(ui: ToolUi, row: ToolRow): Component | undefined {
  const groups = ui.groups
  groups.trackRow(row.toolCallId, row.invalidate)
  if (groups.isHiddenMember(row.toolCallId)) {
    return renderRowText(row, '')
  }
  return groups.groupLedBy(row.toolCallId) === undefined ? undefined : renderRowText(row, '')
}

function renderStatBody(
  row: ToolRow,
  theme: Theme,
  stat: string,
  lines: readonly string[],
): Component {
  const joined = lines.join('\n')
  return renderRowBody(row, theme, cacheKey(stat, joined), (contentWidth) => {
    const body = renderTruncatedContent(theme, joined, contentWidth, {
      rows: MAX_RENDER_LINES,
      paintLine: dimPaint(theme),
      expandHint: false,
    })
    return body === '' ? stat : `${stat}\n${body}`
  })
}

function renderDiffLines(
  theme: Theme,
  diff: ParsedDiff,
  width: number,
  options: DiffCardOptions,
): string[] {
  const lead = options.lead
  const maxLines = options.maxLines
  const expandHint = options.expandHint
  if (diff.lines.length === 0) {
    return [lead]
  }
  const bodyWidth = Math.max(1, width - RESULT_INDENT.length)
  const body = renderDiffBody(theme, diff, bodyWidth, { maxLines, expandHint })
  return [lead, ...body.map((line) => `${RESULT_INDENT}${line}`)]
}

function renderWriteListing(
  theme: Theme,
  content: string,
  width: number,
  options: WriteListingOptions,
): string[] {
  const lead = options.lead
  const maxLines = options.maxLines
  const expandHint = options.expandHint
  const language = options.language
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  const all = content === '' ? [] : body.split('\n')
  const shown = all.slice(0, maxLines)
  if (shown.length === 0) {
    return [lead]
  }
  const highlighted = language === undefined ? shown : highlightCode(shown.join('\n'), language)
  const lines = highlighted.length === shown.length ? highlighted : shown
  const bodyWidth = Math.max(1, width - RESULT_INDENT.length)
  const listing = renderNumberedListing(theme, lines, bodyWidth, {
    hiddenLines: all.length - shown.length,
    expandHint,
  })
  return [lead, ...listing.map((line) => `${RESULT_INDENT}${line}`)]
}

function formatLiveLineCount(theme: Theme, row: ToolRow): string {
  const count = row.state.liveLineCount
  if (!row.isPartial || count === undefined || count === 0) {
    return ''
  }
  return ` ${theme.fg('muted', `(${count} ${pluralize(count, 'line')})`)}`
}

function readRenderer(ui: ToolUi): ToolRenderer {
  return {
    renderCall(theme, row) {
      const grouped = renderGroupedCall(ui, theme, row)
      if (grouped !== undefined) {
        return grouped
      }
      const summary = shortPath(row.cwd, argString<ReadToolInput>(row.args, 'path'))
      return renderRowHeader(
        row,
        formatToolHeader(theme, 'Read', summary, renderRowDot(ui, theme, row)),
      )
    },
    renderResult(result, options, theme, row) {
      const expanded = options.expanded
      const grouped = renderGroupedResult(ui, row)
      if (grouped !== undefined) {
        return grouped
      }
      if (row.isPartial) {
        return renderRowText(row, formatResultStatus(theme, 'dim', 'Reading…'))
      }
      if (row.isError) {
        return renderRowText(row, formatResultError(theme, result, 'Error reading file'))
      }
      if (toolResultHasImage(result)) {
        return renderRowText(row, formatResultStatus(theme, 'dim', IMAGE_RESULT_NOTICE))
      }
      const visible = stripReadContinuationNotice(toolResultText(result))
      const truncation = readTruncation(result.details)
      const truncated = truncation?.truncated === true
      const total = truncated ? truncation.totalLines : countLines(visible)
      const stat = `Read ${theme.bold(String(total))} ${pluralize(total, 'line')}`
      const text = truncated ? `${stat}${theme.fg('warning', ' (truncated)')}` : stat
      if (!expanded) {
        return renderRowText(row, formatResultLine(theme, text))
      }
      return renderStatBody(row, theme, text, visible.split('\n'))
    },
  }
}

function shellRenderer(ui: ToolUi, label: string): ToolRenderer {
  return {
    renderCall(theme, row) {
      const grouped = renderGroupedCall(ui, theme, row)
      if (grouped !== undefined) {
        return grouped
      }
      const header = formatToolHeader(
        theme,
        label,
        truncateCommand(argString<BashToolInput>(row.args, 'command')),
        renderRowDot(ui, theme, row),
      )
      return renderRowHeader(row, header + formatLiveLineCount(theme, row))
    },
    renderResult(result, options, theme, row) {
      const expanded = options.expanded
      const grouped = renderGroupedResult(ui, row)
      if (grouped !== undefined) {
        return grouped
      }
      const output = toolResultText(result)

      if (row.isPartial) {
        const streamed = tailNonEmptyLines(output, STREAM_PREVIEW_ROWS)
        row.state.liveLineCount = streamed.total
        if (streamed.total === 0) {
          return renderRowText(row, formatResultStatus(theme, 'dim', 'Running…'))
        }
        const key = cacheKey('stream', streamed.total, streamed.lines.join('\n'))
        return renderRowBody(row, theme, key, (contentWidth) => {
          const tail = renderTailRows(streamed.lines, contentWidth, {
            rows: STREAM_PREVIEW_ROWS,
            paintLine: dimPaint(theme),
          })
          return `${theme.fg('dim', 'Running…')}\n${tail}`
        })
      }

      const lines = nonEmptyLines(output)
      let status = ''
      if (row.isError) {
        const exitCode = lastExitCode(output)
        status = theme.fg('error', exitCode === undefined ? 'Error' : `Exit ${exitCode}`)
      }

      if (lines.length === 0) {
        const empty = status === '' ? theme.fg('dim', '(No output)') : status
        return renderRowText(row, formatResultLine(theme, empty))
      }

      const rows = expanded ? MAX_RENDER_LINES : previewLineLimit(ui)
      const key = cacheKey('output', status, rows, output)
      return renderRowBody(row, theme, key, (contentWidth) => {
        const body = renderTruncatedContent(theme, lines.join('\n'), contentWidth, {
          rows,
          paintLine: expanded ? (line) => line : dimPaint(theme),
          expandHint: !expanded,
        })
        return status === '' ? body : `${status}\n${body}`
      })
    },
  }
}

function grepRenderer(ui: ToolUi): ToolRenderer {
  return {
    renderCall(theme, row) {
      const grouped = renderGroupedCall(ui, theme, row)
      if (grouped !== undefined) {
        return grouped
      }
      const path = argString<GrepToolInput>(row.args, 'path')
      const pattern = argString<GrepToolInput>(row.args, 'pattern')
      const summary = `pattern: "${pattern}"${path === '' ? '' : `, path: "${path}"`}`
      return renderRowHeader(
        row,
        formatToolHeader(theme, 'Grep', summary, renderRowDot(ui, theme, row)),
      )
    },
    renderResult(result, options, theme, row) {
      const expanded = options.expanded
      const grouped = renderGroupedResult(ui, row)
      if (grouped !== undefined) {
        return grouped
      }
      if (row.isPartial) {
        return renderRowText(row, formatResultStatus(theme, 'dim', 'Searching…'))
      }
      if (row.isError) {
        return renderRowText(row, formatResultError(theme, result, 'Error searching files'))
      }
      const matches = listedItems(result)
      if (matches.length === 0) {
        return renderRowText(row, formatResultStatus(theme, 'muted', 'no matches'))
      }
      const files = countGrepFiles(matches)
      const stat = `Found ${theme.bold(String(files))} ${pluralize(files, 'file')}`
      if (!expanded) {
        return renderRowText(row, formatResultLine(theme, stat))
      }
      return renderStatBody(row, theme, stat, matches)
    },
  }
}

function findRenderer(ui: ToolUi): ToolRenderer {
  return {
    renderCall(theme, row) {
      const grouped = renderGroupedCall(ui, theme, row)
      if (grouped !== undefined) {
        return grouped
      }
      const path = argString<FindToolInput>(row.args, 'path')
      const pattern = truncateChars(
        collapseWhitespace(argString<FindToolInput>(row.args, 'pattern')),
        MAX_FIND_PATTERN_CHARS,
      )
      const summary = `"${pattern}"${path === '' ? '' : ` in ${path}`}`
      return renderRowHeader(
        row,
        formatToolHeader(theme, 'Find', summary, renderRowDot(ui, theme, row)),
      )
    },
    renderResult(result, options, theme, row) {
      const expanded = options.expanded
      const grouped = renderGroupedResult(ui, row)
      if (grouped !== undefined) {
        return grouped
      }
      if (row.isPartial) {
        return renderRowText(row, formatResultStatus(theme, 'dim', 'Finding…'))
      }
      if (row.isError) {
        return renderRowText(row, formatResultError(theme, result, 'Error finding files'))
      }
      const items = listedItems(result)
      if (items.length === 0) {
        return renderRowText(row, formatResultStatus(theme, 'muted', 'no files found'))
      }
      const stat = `${theme.bold(String(items.length))} ${pluralize(items.length, 'file')}`
      if (!expanded) {
        return renderRowText(row, formatResultLine(theme, stat))
      }
      return renderStatBody(row, theme, stat, items)
    },
  }
}

function lsRenderer(ui: ToolUi): ToolRenderer {
  return {
    renderCall(theme, row) {
      const grouped = renderGroupedCall(ui, theme, row)
      if (grouped !== undefined) {
        return grouped
      }
      const path = argString<LsToolInput>(row.args, 'path')
      const summary = shortPath(row.cwd, path === '' ? '.' : path)
      return renderRowHeader(
        row,
        formatToolHeader(theme, 'Ls', summary, renderRowDot(ui, theme, row)),
      )
    },
    renderResult(result, options, theme, row) {
      const expanded = options.expanded
      const grouped = renderGroupedResult(ui, row)
      if (grouped !== undefined) {
        return grouped
      }
      if (row.isPartial) {
        return renderRowText(row, formatResultStatus(theme, 'dim', 'Listing…'))
      }
      if (row.isError) {
        return renderRowText(row, formatResultError(theme, result, 'Error listing directory'))
      }
      const items = listedItems(result)
      if (items.length === 0) {
        return renderRowText(row, formatResultStatus(theme, 'muted', 'empty directory'))
      }
      const stat = `${theme.bold(String(items.length))} ${pluralize(items.length, 'entry', 'entries')}`
      if (!expanded) {
        return renderRowText(row, formatResultLine(theme, stat))
      }
      return renderStatBody(row, theme, stat, items)
    },
  }
}

function writeRenderer(
  ui: ToolUi,
  writeSnapshots: ReadonlyMap<string, WriteSnapshot>,
): ToolRenderer {
  return {
    renderCall(theme, row) {
      const path = argString<WriteToolInput>(row.args, 'path')
      return renderRowHeader(
        row,
        formatToolHeader(theme, 'Write', shortPath(row.cwd, path), renderRowDot(ui, theme, row)),
      )
    },
    renderResult(result, options, theme, row) {
      const expanded = options.expanded
      if (row.isPartial) {
        return renderRowText(row, formatResultStatus(theme, 'dim', 'Writing…'))
      }
      if (row.isError) {
        return renderRowText(row, formatResultError(theme, result, 'Error'))
      }

      const path = argString<WriteToolInput>(row.args, 'path')
      const content = sanitizeToolText(argString<WriteToolInput>(row.args, 'content'))
      const snapshot = writeSnapshots.get(row.toolCallId)
      const lineCount = countLines(content)
      const wrote = `Wrote ${theme.bold(String(lineCount))} ${pluralize(lineCount, 'line')} to ${theme.bold(shortPath(row.cwd, path))}`
      if (snapshot === undefined || snapshot.kind === 'unreadable') {
        return renderRowText(row, formatResultLine(theme, wrote))
      }

      if (snapshot.kind === 'created') {
        const key = cacheKey('write-listing', row.toolCallId, content.length, expanded)
        return renderDiffCard(row, theme, key, (width) =>
          renderWriteListing(theme, content, width, {
            lead: formatResultLine(theme, wrote),
            maxLines: expanded ? MAX_RENDER_LINES : WRITE_PREVIEW_LINES,
            expandHint: !expanded,
            language: getLanguageFromPath(path),
          }),
        )
      }

      const oldContent = snapshot.oldContent
      const diff = parseDiff(oldContent, content)
      const stat = formatDiffStat(theme, diff.added, diff.removed)
      const key = cacheKey('write', row.toolCallId, oldContent.length, content.length, expanded)
      return renderDiffCard(row, theme, key, (width) =>
        renderDiffLines(theme, diff, width, {
          lead: formatResultLine(theme, stat === '' ? 'Written' : stat),
          maxLines: expanded ? MAX_RENDER_LINES : MAX_PREVIEW_LINES,
          expandHint: !expanded,
        }),
      )
    },
  }
}

function editRenderer(ui: ToolUi): ToolRenderer {
  return {
    renderCall(theme, row) {
      const summary = shortPath(row.cwd, argString<EditToolInput>(row.args, 'path'))
      return renderRowHeader(
        row,
        formatToolHeader(theme, 'Edit', summary, renderRowDot(ui, theme, row)),
      )
    },
    renderResult(result, options, theme, row) {
      const expanded = options.expanded
      if (row.isPartial) {
        return renderRowText(row, formatResultStatus(theme, 'dim', 'Editing…'))
      }
      if (row.isError) {
        return renderRowText(row, formatResultError(theme, result, 'Error'))
      }

      const path = argString<EditToolInput>(row.args, 'path')
      const edits = argEdits(row.args)
      const patch = editPatch(result.details)
      const patchDiff = patch === undefined ? undefined : parseUnifiedPatch(patch)
      const oldCombined = edits.map((edit) => edit.oldText).join('\n')
      const newCombined = edits.map((edit) => edit.newText).join('\n')
      const diff = patchDiff ?? parseDiff(oldCombined, newCombined)
      const stat = formatDiffStat(theme, diff.added, diff.removed)
      const shape =
        patch === undefined || patchDiff === undefined
          ? cacheKey('edits', edits.length, oldCombined.length, newCombined.length)
          : cacheKey('patch', patch.length)
      const key = cacheKey('edit', row.toolCallId, path, shape, expanded)
      return renderDiffCard(row, theme, key, (width) =>
        renderDiffLines(theme, diff, width, {
          lead: formatResultLine(theme, stat === '' ? 'Applied' : stat),
          maxLines: expanded ? MAX_RENDER_LINES : MAX_PREVIEW_LINES,
          expandHint: !expanded,
        }),
      )
    },
  }
}

export function createBuiltinRenderers(
  pi: ExtensionAPI,
  settings: Settings,
  groups: ToolGroups,
): ReadonlyMap<string, ToolRenderer> {
  const ui: ToolUi = { settings, groups }
  const writeSnapshots = new Map<string, WriteSnapshot>()
  let sessionCwd = process.cwd()

  pi.on('session_start', (_event, ctx) => {
    sessionCwd = ctx.cwd
    writeSnapshots.clear()
  })

  pi.on('tool_execution_start', (event) => {
    if (event.toolName !== WRITE_TOOL_NAME) {
      return
    }
    writeSnapshots.set(
      event.toolCallId,
      snapshotWriteTarget(sessionCwd, argString<WriteToolInput>(event.args, 'path')),
    )
    while (writeSnapshots.size > MAX_WRITE_SNAPSHOTS) {
      const oldest = writeSnapshots.keys().next().value
      if (oldest === undefined) {
        break
      }
      writeSnapshots.delete(oldest)
    }
  })

  const renderers: Record<BuiltinToolName, ToolRenderer> = {
    read: readRenderer(ui),
    bash: shellRenderer(ui, BASH_LABEL),
    powershell: shellRenderer(ui, POWERSHELL_LABEL),
    grep: grepRenderer(ui),
    find: findRenderer(ui),
    ls: lsRenderer(ui),
    write: writeRenderer(ui, writeSnapshots),
    edit: editRenderer(ui),
  }
  return new Map(Object.entries(renderers))
}
