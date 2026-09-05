import { collapseWhitespace, truncateChars } from '../format.js'
import { isRecord } from '../guards.js'
import type { FormatPath } from '../paths.js'

const CAMEL_BOUNDARY_RE = /(?<lower>[a-z\d])(?<upper>[A-Z])/gu

const MCP_TOOL_PREFIX = 'mcp__'
const MCP_SEPARATOR = '__'
const MCP_VERB_SEGMENTS = 2
const MCP_READ_VERBS = new Set([
  'search',
  'find',
  'get',
  'list',
  'read',
  'fetch',
  'query',
  'describe',
  'view',
  'lookup',
  'browse',
  'inspect',
  'show',
])
const MCP_WRITE_VERBS = new Set([
  'create',
  'update',
  'delete',
  'remove',
  'write',
  'set',
  'add',
  'send',
  'post',
  'patch',
  'save',
  'clear',
  'drop',
  'move',
  'rename',
  'upload',
  'insert',
  'edit',
  'append',
  'archive',
  'close',
  'cancel',
  'run',
  'execute',
])

const MAX_HINT_CHARS = 300

const BASH_PROMPT = '$'
const POWERSHELL_PROMPT = 'PS>'

export type GlanceHint =
  | { readonly kind: 'path' | 'pattern' | 'comment' | 'thinking'; readonly text: string }
  | { readonly kind: 'command'; readonly text: string; readonly prompt: string }

export type ToolGlance =
  | { readonly kind: 'search'; readonly hint: GlanceHint | undefined }
  | {
      readonly kind: 'read'
      readonly path: string | undefined
      readonly hint: GlanceHint | undefined
    }
  | { readonly kind: 'list'; readonly hint: GlanceHint | undefined }
  | { readonly kind: 'shell'; readonly hint: GlanceHint }
  | { readonly kind: 'mcp'; readonly server: string; readonly hint: GlanceHint | undefined }

export interface ToolCallArguments {
  readonly path: string | undefined
  readonly pattern: string | undefined
  readonly command: string | undefined
  readonly query: string | undefined
}

function textArgument(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function readToolCallArguments(args: unknown): ToolCallArguments {
  if (!isRecord(args)) {
    return { path: undefined, pattern: undefined, command: undefined, query: undefined }
  }
  return {
    path: textArgument(args, 'path') ?? textArgument(args, 'file_path'),
    pattern: textArgument(args, 'pattern'),
    command: textArgument(args, 'command'),
    query: textArgument(args, 'query'),
  }
}

function mcpParts(name: string): { server: string; verbs: string } | undefined {
  if (!name.startsWith(MCP_TOOL_PREFIX)) {
    return undefined
  }
  const rest = name.slice(MCP_TOOL_PREFIX.length)
  const separator = rest.indexOf(MCP_SEPARATOR)
  if (separator <= 0) {
    return undefined
  }
  return {
    server: rest.slice(0, separator),
    verbs: rest.slice(separator + MCP_SEPARATOR.length),
  }
}

function isMcpQuery(verbs: string): boolean {
  const segments = verbs
    .replaceAll(CAMEL_BOUNDARY_RE, '$<lower>_$<upper>')
    .replaceAll('-', '_')
    .toLowerCase()
    .split('_')
    .filter((part) => part !== '')
  const first = segments[0]
  if (first !== undefined && MCP_WRITE_VERBS.has(first)) {
    return false
  }
  return segments.slice(0, MCP_VERB_SEGMENTS).some((part) => MCP_READ_VERBS.has(part))
}

function compactCommand(command: string): string {
  return command
    .split('\n')
    .map((line) => collapseWhitespace(line))
    .filter((line) => line !== '')
    .join('\n')
}

function leadingComment(command: string): string | undefined {
  for (const line of command.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '') {
      if (!trimmed.startsWith('#')) {
        return undefined
      }
      const text = trimmed.slice(1).trim()
      return text === '' ? undefined : text
    }
  }
  return undefined
}

function stripLeadingComments(command: string): string {
  const lines = command.split('\n')
  let index = 0
  while (index < lines.length) {
    const trimmed = (lines[index] ?? '').trim()
    if (trimmed !== '' && !trimmed.startsWith('#')) {
      break
    }
    index += 1
  }
  return lines.slice(index).join('\n')
}

function classifyShellCall(command: string, prompt: string): ToolGlance {
  const comment = leadingComment(command)
  const hint: GlanceHint =
    comment === undefined
      ? { kind: 'command', text: compactCommand(stripLeadingComments(command)), prompt }
      : { kind: 'comment', text: comment }
  return { kind: 'shell', hint }
}

export function classifyToolCall(
  toolName: string,
  args: ToolCallArguments,
): ToolGlance | undefined {
  const mcp = mcpParts(toolName)
  if (mcp !== undefined) {
    if (!isMcpQuery(mcp.verbs)) {
      return undefined
    }
    const query = args.query ?? args.pattern
    return {
      kind: 'mcp',
      server: mcp.server,
      hint: query === undefined ? undefined : { kind: 'pattern', text: query },
    }
  }
  switch (toolName) {
    case 'read': {
      const path = args.path
      return {
        kind: 'read',
        path,
        hint: path === undefined ? undefined : { kind: 'path', text: path },
      }
    }
    case 'grep':
    case 'find': {
      const pattern = args.pattern
      return {
        kind: 'search',
        hint: pattern === undefined ? undefined : { kind: 'pattern', text: pattern },
      }
    }
    case 'ls': {
      return { kind: 'list', hint: undefined }
    }
    case 'bash': {
      return args.command === undefined ? undefined : classifyShellCall(args.command, BASH_PROMPT)
    }
    case 'powershell': {
      return args.command === undefined
        ? undefined
        : classifyShellCall(args.command, POWERSHELL_PROMPT)
    }
    default: {
      return undefined
    }
  }
}

function glanceHintText(hint: GlanceHint, formatPath: FormatPath): string {
  switch (hint.kind) {
    case 'path': {
      return formatPath(hint.text)
    }
    case 'thinking':
    case 'comment': {
      return hint.text
    }
    case 'pattern': {
      return `"${hint.text}"`
    }
    case 'command': {
      return `${hint.prompt} ${hint.text}`
    }
  }
}

export function formatGlanceHint(hint: GlanceHint, formatPath: FormatPath): string {
  return truncateChars(glanceHintText(hint, formatPath), MAX_HINT_CHARS)
}
