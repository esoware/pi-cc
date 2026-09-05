import type { Theme } from '@earendil-works/pi-coding-agent'

import { pluralize } from '../format.js'

export function readStat(theme: Theme, lines: number, truncated: boolean): string {
  const stat = `Read ${theme.bold(String(lines))} ${pluralize(lines, 'line')}`
  return truncated ? `${stat}${theme.fg('warning', ' (truncated)')}` : stat
}

export function grepStat(theme: Theme, files: number): string {
  if (files === 0) {
    return theme.fg('muted', 'no matches')
  }
  return `Found ${theme.bold(String(files))} ${pluralize(files, 'file')}`
}

export function findStat(theme: Theme, files: number): string {
  if (files === 0) {
    return theme.fg('muted', 'no files found')
  }
  return `${theme.bold(String(files))} ${pluralize(files, 'file')}`
}

export function lsStat(theme: Theme, entries: number): string {
  if (entries === 0) {
    return theme.fg('muted', 'empty directory')
  }
  return `${theme.bold(String(entries))} ${pluralize(entries, 'entry', 'entries')}`
}

export function shellStatus(theme: Theme, exitCode: string | undefined): string {
  return theme.fg('error', exitCode === undefined ? 'Error' : `Exit ${exitCode}`)
}
