import { homedir } from 'node:os'
import { isAbsolute, relative } from 'node:path'

export type FormatPath = (path: string) => string

export function tildeHome(path: string): string {
  const home = homedir()
  if (path === home) {
    return '~'
  }
  return path.startsWith(`${home}/`) || path.startsWith(`${home}\\`)
    ? `~${path.slice(home.length)}`
    : path
}

export function shortPath(cwd: string, path: string): string {
  if (path === '') {
    return ''
  }
  const relativePath = relative(cwd, path)
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return tildeHome(path)
  }
  return relativePath === '' ? '.' : relativePath
}
