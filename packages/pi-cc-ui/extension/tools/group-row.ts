import type { Theme } from '@earendil-works/pi-coding-agent'

import type { PaintText } from '../ansi.js'
import { shortPath } from '../paths.js'
import type { Settings } from '../settings.js'
import { renderCollapsedGroup, renderGroupPreview } from './group-render.js'
import type { ToolGroups, ToolRecord } from './groups.js'
import { renderTruncatedContent, tailNonEmptyLines } from './layout.js'

const PREVIEW_LINES = 8
const EXTRA_DETAIL_LINES = 12_000
const GROUP_PREVIEW_WIDTH = 80

export interface ToolUi {
  readonly settings: Settings
  readonly groups: ToolGroups
}

export interface GroupRowContext {
  readonly toolCallId: string
  readonly cwd: string
  readonly expanded: boolean
  readonly invalidate: () => void
}

export type GroupRowText =
  | { readonly kind: 'hidden' }
  | { readonly kind: 'group'; readonly text: string }

export function dimPaint(theme: Theme): PaintText {
  return (text) => theme.fg('dim', text)
}

export function previewLineLimit(ui: ToolUi): number {
  return ui.settings.isExtraDetailEnabled() ? EXTRA_DETAIL_LINES : PREVIEW_LINES
}

function renderMemberBody(ui: ToolUi, theme: Theme, member: ToolRecord): string {
  if (member.status === 'pending') {
    return theme.fg('dim', '…')
  }
  const text = member.resultText ?? ''
  if (text === '') {
    return ''
  }
  const rows = previewLineLimit(ui)
  const lines = tailNonEmptyLines(text, rows).lines
  return renderTruncatedContent(theme, lines.join('\n'), GROUP_PREVIEW_WIDTH, {
    rows,
    paintLine: dimPaint(theme),
    expandHint: false,
  })
}

export function groupRowText(
  ui: ToolUi,
  theme: Theme,
  row: GroupRowContext,
): GroupRowText | undefined {
  const groups = ui.groups
  groups.trackRow(row.toolCallId, row.invalidate)
  if (groups.isHiddenMember(row.toolCallId)) {
    return { kind: 'hidden' }
  }
  const group = groups.groupLedBy(row.toolCallId)
  if (group === undefined) {
    return undefined
  }
  function formatRowPath(path: string): string {
    return shortPath(row.cwd, path)
  }
  if (row.expanded) {
    return {
      kind: 'group',
      text: renderGroupPreview(theme, group, {
        formatPath: formatRowPath,
        dotVisible: groups.blinkVisible(),
        renderMemberBody: (member) => renderMemberBody(ui, theme, member),
      }),
    }
  }
  return {
    kind: 'group',
    text: renderCollapsedGroup(theme, group, {
      hint: groups.hintTextFor(group, formatRowPath),
      dotVisible: group.phase === 'live' ? groups.keepBlinking() : true,
    }),
  }
}
