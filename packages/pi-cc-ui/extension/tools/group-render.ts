import type { Theme } from '@earendil-works/pi-coding-agent'

import { dim } from '../ansi.js'
import { formatDuration } from '../format.js'
import { groupHasError } from './groups.js'
import type { ToolGroup, ToolRecord } from './groups.js'
import { indentContinuationLines } from './layout.js'
import { renderStatusDot, RESULT_INDENT, RESULT_LEAD, STATUS_DOT } from './row.js'

const MIN_REPORTED_THINKING_MS = 1000
const GROUP_GUTTER = '  '

export interface GroupHeaderOptions {
  readonly hint: string | undefined
  readonly dotVisible: boolean
  readonly hovered: boolean
}

type CountedKind = 'search' | 'read' | 'list' | 'shell'

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
  shell: { live: 'running', settled: 'ran', one: 'shell command', many: 'shell commands' },
}

interface GlanceCounts {
  readonly search: number
  readonly read: number
  readonly list: number
  readonly shell: number
  readonly mcpCalls: number
  readonly mcpServers: readonly string[]
}

function countGlances(members: readonly ToolRecord[]): GlanceCounts {
  const readPaths = new Set<string>()
  const mcpServers: string[] = []
  let search = 0
  let readsWithoutPath = 0
  let list = 0
  let shell = 0
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
      case 'shell': {
        shell += 1
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
    shell,
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
  addFragment('shell', counts.shell)
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

function groupGutter(theme: Theme, group: ToolGroup, dotVisible: boolean): string {
  const live = group.phase === 'live'
  if (groupHasError(group)) {
    const dot = theme.fg('error', STATUS_DOT)
    return `${live ? dim(dot) : dot} `
  }
  return live ? `${renderStatusDot(theme, 'busy', dotVisible)} ` : GROUP_GUTTER
}

export function renderGroupHeader(
  theme: Theme,
  group: ToolGroup,
  options: GroupHeaderOptions,
): string {
  const live = group.phase === 'live'
  const summary = formatGroupSummary(group, (count) => theme.bold(String(count)))
  const gutter = groupGutter(theme, group, options.dotVisible)
  const text = options.hovered ? summary : theme.fg('dim', summary)
  const hint = options.hint
  const hintLine =
    live && hint !== undefined
      ? `\n${theme.fg('dim', `${RESULT_LEAD}${indentContinuationLines(hint, RESULT_INDENT)}`)}`
      : ''
  return `${gutter}${text}${hintLine}`
}
