import type { Theme } from '@earendil-works/pi-coding-agent'

import { dim } from '../ansi.js'
import { collapseWhitespace, formatDuration, truncateChars } from '../format.js'
import type { FormatPath } from '../paths.js'
import { MCP_TOOL_PREFIX } from './classify.js'
import type { ToolGroup, ToolRecord } from './groups.js'
import { groupHasError } from './groups.js'
import { expandKeyHint, indentContinuationLines } from './layout.js'
import { renderStatusDot, RESULT_INDENT, RESULT_LEAD, STATUS_DOT } from './row.js'
import type { DotState } from './row.js'

const MIN_REPORTED_THINKING_MS = 1000
const MAX_GLANCE_COMMAND_CHARS = 72
const BRANCH_LAST = '└'
const BRANCH_MORE = '├'
const BRANCH_STEM = '│'
const BRANCH_GUTTER = '  '

const GLANCE_TOOL_LABELS: Readonly<Record<string, string>> = {
  read: 'Read',
  bash: 'Bash',
  powershell: 'PowerShell',
  grep: 'Grep',
  find: 'Find',
  ls: 'Ls',
}

type CountedKind = 'search' | 'read' | 'list'

interface SummaryFragment {
  readonly live: string
  readonly settled: string
  readonly one: string
  readonly many: string
}

const SUMMARY_FRAGMENTS: Readonly<Record<CountedKind, SummaryFragment>> = {
  search: {
    live: 'searching for',
    settled: 'searched for',
    one: 'pattern',
    many: 'patterns',
  },
  read: { live: 'reading', settled: 'read', one: 'file', many: 'files' },
  list: { live: 'listing', settled: 'listed', one: 'directory', many: 'directories' },
}

interface GlanceCounts {
  readonly search: number
  readonly read: number
  readonly list: number
  readonly mcpCalls: number
  readonly mcpServers: readonly string[]
}

interface CollapsedGroupOptions {
  readonly hint: string | undefined
  readonly dotVisible: boolean
}

interface GroupPreviewOptions {
  readonly formatPath: FormatPath
  readonly dotVisible: boolean
  readonly renderMemberBody: (member: ToolRecord) => string
}

function countGlances(members: readonly ToolRecord[]): GlanceCounts {
  const readPaths = new Set<string>()
  const mcpServers: string[] = []
  let search = 0
  let readsWithoutPath = 0
  let list = 0
  let mcpCalls = 0
  for (const member of members) {
    const glance = member.glance
    switch (glance?.kind) {
      case 'search': {
        search += 1
        break
      }
      case 'list': {
        list += 1
        break
      }
      case 'mcp': {
        mcpCalls += 1
        if (!mcpServers.includes(glance.server)) {
          mcpServers.push(glance.server)
        }
        break
      }
      case 'read': {
        if (glance.path === undefined) {
          readsWithoutPath += 1
        } else {
          readPaths.add(glance.path)
        }
        break
      }
      case undefined: {
        break
      }
    }
  }
  return {
    search,
    read: readPaths.size + readsWithoutPath,
    list,
    mcpCalls,
    mcpServers,
  }
}

function formatGroupSummary(group: ToolGroup, paintCount: (count: number) => string): string {
  const live = group.phase === 'live'
  const counts = countGlances(group.members)
  const parts: string[] = []

  function addFragment(kind: CountedKind, count: number): void {
    if (count === 0) {
      return
    }
    const fragment = SUMMARY_FRAGMENTS[kind]
    const verb = live ? fragment.live : fragment.settled
    parts.push(`${verb} ${paintCount(count)} ${count === 1 ? fragment.one : fragment.many}`)
  }

  const thinkingMs = Math.max(0, group.thinkingMs)
  if (thinkingMs >= MIN_REPORTED_THINKING_MS) {
    parts.push(`${live ? 'thinking for' : 'thought for'} ${formatDuration(thinkingMs)}`)
  }
  addFragment('search', counts.search)
  addFragment('read', counts.read)
  addFragment('list', counts.list)
  if (counts.mcpCalls > 0) {
    const server = counts.mcpServers.length > 0 ? counts.mcpServers.join(', ') : 'MCP'
    const times = counts.mcpCalls === 1 ? '' : ` ${paintCount(counts.mcpCalls)} times`
    parts.push(`${live ? 'querying' : 'queried'} ${server}${times}`)
  }

  const text = parts.join(', ')
  const capped = text === '' ? text : text.charAt(0).toUpperCase() + text.slice(1)
  return live ? `${capped}…` : capped
}

function formatHintLine(theme: Theme, hint: string): string {
  return `\n${theme.fg('dim', `${RESULT_LEAD}${indentContinuationLines(hint, RESULT_INDENT)}`)}`
}

export function renderCollapsedGroup(
  theme: Theme,
  group: ToolGroup,
  options: CollapsedGroupOptions,
): string {
  const live = group.phase === 'live'
  const summary = formatGroupSummary(group, (count) => theme.bold(String(count)))
  let gutter = '  '
  if (live) {
    gutter = groupHasError(group)
      ? `${dim(theme.fg('error', STATUS_DOT))} `
      : `${renderStatusDot(theme, 'busy', options.dotVisible)} `
  }
  const text = live ? summary : theme.fg('dim', summary)
  const expandHint = theme.italic(theme.fg('dim', `(${expandKeyHint()})`))
  const hintLine = options.hint === undefined ? '' : formatHintLine(theme, options.hint)
  return `${gutter}${text} ${expandHint}${hintLine}`
}

function toolLabel(toolName: string): string {
  const label = GLANCE_TOOL_LABELS[toolName]
  if (label !== undefined) {
    return label
  }
  return toolName.startsWith(MCP_TOOL_PREFIX) ? 'MCP' : toolName
}

function formatMemberSummary(member: ToolRecord, formatPath: FormatPath): string {
  const args = member.args
  switch (member.toolName) {
    case 'read': {
      return args.path === undefined ? '' : formatPath(args.path)
    }
    case 'bash':
    case 'powershell': {
      return args.command === undefined
        ? ''
        : truncateChars(collapseWhitespace(args.command), MAX_GLANCE_COMMAND_CHARS)
    }
    case 'grep':
    case 'find': {
      const pattern = args.pattern === undefined ? '' : `"${args.pattern}"`
      const path = args.path === undefined ? '' : formatPath(args.path)
      return path === '' ? pattern : `${pattern} in ${path}`
    }
    case 'ls': {
      return formatPath(args.path ?? '.')
    }
    default: {
      return ''
    }
  }
}

function memberDotState(member: ToolRecord): DotState {
  switch (member.status) {
    case 'pending': {
      return 'busy'
    }
    case 'success': {
      return 'success'
    }
    case 'error': {
      return 'error'
    }
  }
}

function renderGlanceLine(
  theme: Theme,
  member: ToolRecord,
  isLast: boolean,
  options: GroupPreviewOptions,
): string {
  const branch = theme.fg('dim', isLast ? BRANCH_LAST : BRANCH_MORE)
  const dot = renderStatusDot(theme, memberDotState(member), options.dotVisible)
  const label = theme.bold(toolLabel(member.toolName))
  const summary = formatMemberSummary(member, options.formatPath)
  return `${branch} ${dot} ${label}${summary === '' ? '' : `(${summary})`}`
}

function memberBodyPrefix(theme: Theme, isLast: boolean): { lead: string; indent: string } {
  const branch = isLast ? BRANCH_GUTTER : `${theme.fg('dim', BRANCH_STEM)} `
  return {
    lead: `${branch}${theme.fg('dim', RESULT_LEAD)}`,
    indent: `${branch}${RESULT_INDENT}`,
  }
}

export function renderGroupPreview(
  theme: Theme,
  group: ToolGroup,
  options: GroupPreviewOptions,
): string {
  const lines: string[] = []
  for (const entry of group.members.entries()) {
    const member = entry[1]
    const isLast = entry[0] === group.members.length - 1
    lines.push(renderGlanceLine(theme, member, isLast, options))
    const body = options.renderMemberBody(member)
    if (body !== '') {
      const prefix = memberBodyPrefix(theme, isLast)
      const bodyLines = body.split('\n')
      lines.push(`${prefix.lead}${bodyLines[0] ?? ''}`)
      for (const line of bodyLines.slice(1)) {
        lines.push(`${prefix.indent}${line}`)
      }
    }
  }
  return lines.join('\n')
}
