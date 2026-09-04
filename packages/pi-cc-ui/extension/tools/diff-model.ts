import { structuredPatch } from 'diff'

const CONTEXT_LINES = 3
const HUNK_HEADER_RE = /^@@ -(?<oldStart>\d+)(?:,(?<oldCount>\d+))? \+(?<newStart>\d+)(?:,\d+)? @@/u
const NO_NEWLINE_MARKER = '\\'

type DiffLineType = 'add' | 'del' | 'ctx' | 'sep'

export interface DiffLine {
  readonly type: DiffLineType
  readonly oldNumber: number | undefined
  readonly newNumber: number | undefined
  readonly content: string
}

export interface ParsedDiff {
  readonly lines: readonly DiffLine[]
  readonly added: number
  readonly removed: number
  readonly chars: number
}

interface PatchHunk {
  readonly oldStart: number
  readonly oldLines: number
  readonly newStart: number
  readonly lines: string[]
}

export function maxLineNumber(lines: readonly DiffLine[]): number {
  let max = 0
  for (const line of lines) {
    const value = Math.max(line.oldNumber ?? 0, line.newNumber ?? 0)
    if (value > max) {
      max = value
    }
  }
  return max
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function collectDiffLines(hunks: readonly PatchHunk[]): ParsedDiff {
  const lines: DiffLine[] = []
  let added = 0
  let removed = 0
  let chars = 0
  for (const entry of hunks.entries()) {
    const index = entry[0]
    const hunk = entry[1]
    const previous = index > 0 ? hunks[index - 1] : undefined
    if (previous !== undefined) {
      const gap = hunk.oldStart - (previous.oldStart + previous.oldLines)
      lines.push({
        type: 'sep',
        oldNumber: undefined,
        newNumber: gap > 0 ? gap : undefined,
        content: '',
      })
    }
    let oldNumber = hunk.oldStart
    let newNumber = hunk.newStart
    for (const rawLine of hunk.lines) {
      const line = stripCarriageReturn(rawLine)
      if (!line.startsWith(NO_NEWLINE_MARKER)) {
        const content = line.slice(1)
        chars += content.length
        if (line.startsWith('+')) {
          lines.push({ type: 'add', oldNumber: undefined, newNumber, content })
          newNumber += 1
          added += 1
        } else if (line.startsWith('-')) {
          lines.push({ type: 'del', oldNumber, newNumber: undefined, content })
          oldNumber += 1
          removed += 1
        } else {
          lines.push({ type: 'ctx', oldNumber, newNumber, content })
          oldNumber += 1
          newNumber += 1
        }
      }
    }
  }
  return { lines, added, removed, chars }
}

export function parseDiff(oldContent: string, newContent: string): ParsedDiff {
  const patch = structuredPatch('', '', oldContent, newContent, '', '', { context: CONTEXT_LINES })
  const parsed = collectDiffLines(patch.hunks)
  return { ...parsed, chars: oldContent.length + newContent.length }
}

function parsePatchHunks(patch: string): PatchHunk[] {
  const rawLines = patch.split('\n')
  if (rawLines.at(-1) === '') {
    rawLines.pop()
  }
  const hunks: PatchHunk[] = []
  for (const rawLine of rawLines) {
    const header = HUNK_HEADER_RE.exec(stripCarriageReturn(rawLine))?.groups
    if (header === undefined) {
      hunks.at(-1)?.lines.push(rawLine)
    } else {
      const oldCount = header['oldCount']
      hunks.push({
        oldStart: Number(header['oldStart']),
        oldLines: oldCount === undefined ? 1 : Number(oldCount),
        newStart: Number(header['newStart']),
        lines: [],
      })
    }
  }
  return hunks
}

export function parseUnifiedPatch(patch: string): ParsedDiff | undefined {
  const parsed = collectDiffLines(parsePatchHunks(patch))
  return parsed.lines.length > 0 ? parsed : undefined
}
