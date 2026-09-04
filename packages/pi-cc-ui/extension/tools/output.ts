import { ESC } from '../ansi.js'
import { isRecord, isUnknownArray } from '../guards.js'

const CSI_8BIT = '\u009B'
const ANSI_SEQUENCE_RE =
  /\u001B\][\s\S]*?(?:\u0007|\u001B\u005C|\u009C)|[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/gu
const UNSAFE_CHAR_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFF9-\uFFFB]/gu

const NOTICE_TRAILER_RE = /\n\n\[[^\n]*\]\s*$/u
const READ_CONTINUATION_NOTICE_RE =
  /\n\n\[(?:\d+ more lines in file|Showing lines \d+-\d+ of \d+(?: \([^)\n]*\))?)\. Use offset=\d+ to continue\.\]$/u
const GREP_FILE_RE = /^(?<file>.+?):\d+: /u
const EXIT_CODE_RE = /Command exited with code (?<code>\d+)/gu

const EMPTY_LISTING_SENTINELS = new Set([
  'No matches found',
  'No files found matching pattern',
  '(empty directory)',
])

function resultBlocks(result: unknown): readonly unknown[] {
  if (!isRecord(result)) {
    return []
  }
  const content = result['content']
  return isUnknownArray(content) ? content : []
}

function stripAnsiSequences(text: string): string {
  if (!text.includes(ESC) && !text.includes(CSI_8BIT)) {
    return text
  }
  return text.replaceAll(ANSI_SEQUENCE_RE, '')
}

export function sanitizeToolText(text: string): string {
  return stripAnsiSequences(text).replaceAll(UNSAFE_CHAR_RE, '')
}

export function toolResultText(result: unknown): string {
  const parts: string[] = []
  for (const block of resultBlocks(result)) {
    if (isRecord(block) && block['type'] === 'text' && typeof block['text'] === 'string') {
      parts.push(sanitizeToolText(block['text']).replaceAll('\r', ''))
    }
  }
  return parts.join('\n')
}

export function toolResultHasImage(result: unknown): boolean {
  return resultBlocks(result).some((block) => isRecord(block) && block['type'] === 'image')
}

export function stripReadContinuationNotice(text: string): string {
  return text.replace(READ_CONTINUATION_NOTICE_RE, '')
}

export function listedItems(result: unknown): string[] {
  const listing = toolResultText(result).replace(NOTICE_TRAILER_RE, '')
  if (EMPTY_LISTING_SENTINELS.has(listing.trim())) {
    return []
  }
  return listing.split('\n').filter((line) => line.trim() !== '')
}

export function countLines(text: string): number {
  if (text === '') {
    return 0
  }
  return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length
}

export function countGrepFiles(matches: readonly string[]): number {
  const files = new Set<string>()
  for (const match of matches) {
    const file = GREP_FILE_RE.exec(match)?.groups?.['file']
    if (file !== undefined) {
      files.add(file)
    }
  }
  if (files.size === 0 && matches.length > 0) {
    return new Set(matches).size
  }
  return files.size
}

export function lastExitCode(output: string): string | undefined {
  return [...output.matchAll(EXIT_CODE_RE)].at(-1)?.groups?.['code']
}
