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
  ReadToolInput,
  Theme,
  WriteToolCallEvent,
  WriteToolInput,
} from '@earendil-works/pi-coding-agent'
import { getLanguageFromPath, highlightCode } from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import { cacheKey } from '../cache.js'
import { collapseWhitespace, escapeNewlines, pluralize, truncateChars } from '../format.js'
import { isRecord, isUnknownArray } from '../guards.js'
import { shortPath } from '../paths.js'
import { parseDiff, parseUnifiedPatch } from './diff-model.js'
import type { ParsedDiff } from './diff-model.js'
import {
  formatDiffStat,
  MAX_PREVIEW_LINES,
  renderDiffBody,
  renderNumberedListing,
} from './diff-render.js'
import type { DiffRenderOptions } from './diff-render.js'
import type { ToolGroups, ToolUi } from './groups.js'
import {
  EXPANDED_LINES,
  nonEmptyLines,
  PREVIEW_LINES,
  renderTailRows,
  renderTruncatedContent,
  tailNonEmptyLines,
} from './layout.js'
import {
  countGrepFiles,
  countLines,
  lastExitCode,
  listedItems,
  readTruncation,
  sanitizeToolText,
  stripExitCodeNotice,
  stripReadContinuationNotice,
  toolResultHasImage,
  toolResultText,
} from './output.js'
import {
  dimPaint,
  expandedBody,
  formatResultError,
  formatResultLine,
  formatResultStatus,
  formatRunningTime,
  formatToolHeader,
  renderDiffCard,
  renderRowBody,
  renderRowHeader,
  renderRowText,
  renderStatusDot,
  RESULT_INDENT,
  rowDotState,
} from './row.js'
import type { ToolRenderer, ToolRow } from './row.js'
import { findStat, grepStat, lsStat, readStat, shellStatus } from './stats.js'

const MAX_COMMAND_DISPLAY_CHARS = 300
const MAX_FIND_PATTERN_CHARS = 40
const WRITE_PREVIEW_LINES = 10
const MAX_DIFF_FILE_BYTES = 1_048_576
const MAX_WRITE_SNAPSHOTS = 64
const IMAGE_RESULT_NOTICE = '[Image data detected and sent to Claude]'
const BASH_LABEL = 'Bash'
const POWERSHELL_LABEL = 'PowerShell'
const RUNNING_STATUS = 'Running…'

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

type WriteSnapshot =
  | { readonly kind: 'created' }
  | { readonly kind: 'overwritten'; readonly oldContent: string }
  | { readonly kind: 'unreadable' }

interface ListingOptions {
  readonly maxLines: number
  readonly expandHint: boolean
  readonly language: string | undefined
}

interface DiffResultOptions {
  readonly diff: ParsedDiff
  readonly lead: string
  readonly key: string
  readonly expanded: boolean
}

type EditPair = EditToolInput['edits'][number]

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

function editPatch(details: unknown): EditToolDetails['patch'] | undefined {
  if (!isRecord(details)) {
    return undefined
  }
  const patch = details[EDIT_PATCH_KEY]
  return typeof patch === 'string' ? sanitizeToolText(patch) : undefined
}

function truncateCommand(command: string): string {
  const inline = escapeNewlines(command)
  return visibleWidth(inline) <= MAX_COMMAND_DISPLAY_CHARS
    ? inline
    : truncateToWidth(inline, MAX_COMMAND_DISPLAY_CHARS, '…')
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

function renderRowDot(ui: ToolUi, theme: Theme, row: ToolRow): string {
  const state = rowDotState(row)
  const dotVisible =
    state === 'busy' ? ui.groups.keepRowBlinking(row.toolCallId, row.invalidate) : true
  return renderStatusDot(theme, state, dotVisible)
}

function withLead(lead: string, body: readonly string[]): string[] {
  return [lead, ...body.map((line) => `${RESULT_INDENT}${line}`)]
}

function leadWithBody(lead: string, body: string): string {
  if (body === '') {
    return lead
  }
  return lead === '' ? body : `${lead}\n${body}`
}

function renderTextResult(row: ToolRow, theme: Theme, lead: string, text: string): Component {
  return renderRowBody(row, theme, cacheKey('full', row.toolCallId, text.length), (contentWidth) =>
    leadWithBody(lead, expandedBody(theme, text, contentWidth)),
  )
}

function diffBodyLines(
  theme: Theme,
  diff: ParsedDiff,
  width: number,
  options: DiffRenderOptions,
): string[] {
  return diff.lines.length === 0 ? [] : renderDiffBody(theme, diff, width, options)
}

function renderDiffResult(row: ToolRow, theme: Theme, options: DiffResultOptions): Component {
  return renderDiffCard(row, theme, cacheKey(options.key, options.expanded), (width) => {
    const bodyWidth = Math.max(1, width - RESULT_INDENT.length)
    return withLead(
      formatResultLine(theme, options.lead),
      diffBodyLines(theme, options.diff, bodyWidth, {
        maxLines: options.expanded ? EXPANDED_LINES : MAX_PREVIEW_LINES,
        expandHint: !options.expanded,
      }),
    )
  })
}

function listingLines(
  theme: Theme,
  content: string,
  width: number,
  options: ListingOptions,
): string[] {
  const body = content.endsWith('\n') ? content.slice(0, -1) : content
  const all = content === '' ? [] : body.split('\n')
  const shown = all.slice(0, options.maxLines)
  if (shown.length === 0) {
    return []
  }
  const language = options.language
  const highlighted = language === undefined ? shown : highlightCode(shown.join('\n'), language)
  const lines = highlighted.length === shown.length ? highlighted : shown
  return renderNumberedListing(theme, lines, width, {
    hiddenLines: all.length - shown.length,
    expandHint: options.expandHint,
  })
}

function formatLiveLineCount(theme: Theme, row: ToolRow): string {
  const count = row.state.liveLineCount
  if (!row.isPartial || count === undefined || count === 0) {
    return ''
  }
  return ` ${theme.fg('muted', `(${count} ${pluralize(count, 'line')})`)}`
}

function renderStreamingResult(
  theme: Theme,
  row: ToolRow,
  output: string,
  expanded: boolean,
): Component {
  const streamed = tailNonEmptyLines(output, PREVIEW_LINES)
  row.state.liveLineCount = streamed.total
  if (streamed.total === 0) {
    return renderRowText(row, formatResultStatus(theme, 'dim', RUNNING_STATUS))
  }
  const running = theme.fg('dim', RUNNING_STATUS)
  if (expanded) {
    return renderRowBody(
      row,
      theme,
      cacheKey('stream-full', row.toolCallId, output.length),
      (contentWidth) => leadWithBody(running, expandedBody(theme, output, contentWidth)),
    )
  }
  const key = cacheKey('stream', streamed.total, streamed.lines.join('\n'))
  return renderRowBody(row, theme, key, (contentWidth) =>
    leadWithBody(
      running,
      renderTailRows(streamed.lines, contentWidth, {
        rows: PREVIEW_LINES,
        paintLine: dimPaint(theme),
      }),
    ),
  )
}

function readRenderer(ui: ToolUi): ToolRenderer {
  return {
    renderCall(theme, row) {
      const summary = shortPath(row.cwd, argString<ReadToolInput>(row.args, 'path'))
      return renderRowHeader(
        row,
        formatToolHeader(theme, 'Read', summary, renderRowDot(ui, theme, row)),
      )
    },
    renderResult(result, options, theme, row) {
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
      const stat = readStat(theme, total, truncated)
      if (!options.expanded) {
        return renderRowText(row, formatResultLine(theme, stat))
      }
      const key = cacheKey('full', row.toolCallId, visible.length, total, truncated)
      return renderRowBody(row, theme, key, (contentWidth) =>
        leadWithBody(stat, expandedBody(theme, visible, contentWidth)),
      )
    },
  }
}

function shellRenderer(ui: ToolUi, label: string): ToolRenderer {
  return {
    renderCall(theme, row) {
      const command = argString<BashToolInput>(row.args, 'command')
      const header = formatToolHeader(
        theme,
        label,
        row.expanded ? command.replaceAll('\r', '') : truncateCommand(command),
        renderRowDot(ui, theme, row),
      )
      const elapsed = formatRunningTime(theme, ui.groups.bashElapsedMsFor(row.toolCallId))
      return renderRowHeader(row, header + formatLiveLineCount(theme, row) + elapsed)
    },
    renderResult(result, options, theme, row) {
      const expanded = options.expanded
      const raw = toolResultText(result)
      if (row.isPartial) {
        return renderStreamingResult(theme, row, raw, expanded)
      }

      const output = stripExitCodeNotice(raw)
      const lines = nonEmptyLines(output)
      const status = row.isError ? shellStatus(theme, lastExitCode(raw)) : ''
      if (lines.length === 0) {
        const empty = status === '' ? theme.fg('dim', '(No output)') : status
        return renderRowText(row, formatResultLine(theme, empty))
      }

      const shape = cacheKey(row.toolCallId, status, output.length)
      if (expanded) {
        return renderRowBody(row, theme, cacheKey('full', shape), (contentWidth) =>
          leadWithBody(status, expandedBody(theme, output, contentWidth)),
        )
      }
      const joined = lines.join('\n')
      return renderRowBody(row, theme, cacheKey('output', shape), (contentWidth) =>
        leadWithBody(
          status,
          renderTruncatedContent(theme, joined, contentWidth, {
            rows: PREVIEW_LINES,
            paintLine: dimPaint(theme),
            expandHint: true,
          }),
        ),
      )
    },
  }
}

function grepRenderer(ui: ToolUi): ToolRenderer {
  return {
    renderCall(theme, row) {
      const path = argString<GrepToolInput>(row.args, 'path')
      const pattern = argString<GrepToolInput>(row.args, 'pattern')
      const summary = `pattern: "${pattern}"${path === '' ? '' : `, path: "${path}"`}`
      return renderRowHeader(
        row,
        formatToolHeader(theme, 'Grep', summary, renderRowDot(ui, theme, row)),
      )
    },
    renderResult(result, options, theme, row) {
      if (row.isPartial) {
        return renderRowText(row, formatResultStatus(theme, 'dim', 'Searching…'))
      }
      if (row.isError) {
        return renderRowText(row, formatResultError(theme, result, 'Error searching files'))
      }
      const matches = listedItems(result)
      const stat = grepStat(theme, countGrepFiles(matches))
      if (options.expanded && matches.length > 0) {
        return renderTextResult(row, theme, stat, matches.join('\n'))
      }
      return renderRowText(row, formatResultLine(theme, stat))
    },
  }
}

function findRenderer(ui: ToolUi): ToolRenderer {
  return {
    renderCall(theme, row) {
      const path = argString<FindToolInput>(row.args, 'path')
      const fullPattern = collapseWhitespace(argString<FindToolInput>(row.args, 'pattern'))
      const pattern = row.expanded
        ? fullPattern
        : truncateChars(fullPattern, MAX_FIND_PATTERN_CHARS)
      const summary = `"${pattern}"${path === '' ? '' : ` in ${path}`}`
      return renderRowHeader(
        row,
        formatToolHeader(theme, 'Find', summary, renderRowDot(ui, theme, row)),
      )
    },
    renderResult(result, options, theme, row) {
      if (row.isPartial) {
        return renderRowText(row, formatResultStatus(theme, 'dim', 'Finding…'))
      }
      if (row.isError) {
        return renderRowText(row, formatResultError(theme, result, 'Error finding files'))
      }
      const items = listedItems(result)
      const stat = findStat(theme, items.length)
      if (options.expanded && items.length > 0) {
        return renderTextResult(row, theme, stat, items.join('\n'))
      }
      return renderRowText(row, formatResultLine(theme, stat))
    },
  }
}

function lsRenderer(ui: ToolUi): ToolRenderer {
  return {
    renderCall(theme, row) {
      const path = argString<LsToolInput>(row.args, 'path')
      const summary = shortPath(row.cwd, path === '' ? '.' : path)
      return renderRowHeader(
        row,
        formatToolHeader(theme, 'Ls', summary, renderRowDot(ui, theme, row)),
      )
    },
    renderResult(result, options, theme, row) {
      if (row.isPartial) {
        return renderRowText(row, formatResultStatus(theme, 'dim', 'Listing…'))
      }
      if (row.isError) {
        return renderRowText(row, formatResultError(theme, result, 'Error listing directory'))
      }
      const items = listedItems(result)
      const stat = lsStat(theme, items.length)
      if (options.expanded && items.length > 0) {
        return renderTextResult(row, theme, stat, items.join('\n'))
      }
      return renderRowText(row, formatResultLine(theme, stat))
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
        const language = getLanguageFromPath(path)
        const key = cacheKey('write-listing', row.toolCallId, content.length, expanded)
        return renderDiffCard(row, theme, key, (width) => {
          const bodyWidth = Math.max(1, width - RESULT_INDENT.length)
          return withLead(
            formatResultLine(theme, wrote),
            listingLines(theme, content, bodyWidth, {
              maxLines: expanded ? EXPANDED_LINES : WRITE_PREVIEW_LINES,
              expandHint: !expanded,
              language,
            }),
          )
        })
      }

      const oldContent = snapshot.oldContent
      const diff = parseDiff(oldContent, content)
      const stat = formatDiffStat(theme, diff.added, diff.removed)
      return renderDiffResult(row, theme, {
        diff,
        lead: stat === '' ? 'Written' : stat,
        key: cacheKey('write', row.toolCallId, oldContent.length, content.length),
        expanded,
      })
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
      return renderDiffResult(row, theme, {
        diff,
        lead: stat === '' ? 'Applied' : stat,
        key: cacheKey('edit', row.toolCallId, path, shape),
        expanded: options.expanded,
      })
    },
  }
}

export function createBuiltinRenderers(
  pi: ExtensionAPI,
  groups: ToolGroups,
): ReadonlyMap<string, ToolRenderer> {
  const ui: ToolUi = { groups }
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
