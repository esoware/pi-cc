import { collapseWhitespace, truncateChars } from '../format.js'
import { isRecord } from '../guards.js'
import type { FormatPath } from '../paths.js'

const BASH_SEARCH_COMMANDS = new Set([
  'find',
  'grep',
  'rg',
  'ag',
  'ack',
  'locate',
  'which',
  'whereis',
])
const BASH_READ_COMMANDS = new Set([
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'stat',
  'file',
  'strings',
  'jq',
  'awk',
  'cut',
  'sort',
  'uniq',
  'tr',
])
const BASH_LIST_COMMANDS = new Set(['ls', 'tree', 'du'])
const BASH_NEUTRAL_COMMANDS = new Set(['echo', 'printf', 'true', 'false', ':'])

const REDIRECT_OPERATORS = new Set(['>', '>>', '>&', '2>', '2>>', '2>&', '<'])
const WRITE_REDIRECT_OPERATORS = new Set(['>', '>>', '>&', '2>', '2>>', '2>&'])
const FD_DUP_OPERATORS = new Set(['>&', '2>&'])
const MULTI_CHAR_OPERATORS = ['2>>', '2>&', '||', '&&', '>>', '>&', '2>']
const SINGLE_CHAR_OPERATORS = new Set(['|', ';', '&', '>', '<', '\n'])
const SEPARATOR_OPERATORS = new Set(['|', '||', '&&', ';', '&'])
const NULL_DEVICE = '/dev/null'
const FIND_MUTATING_FLAGS = new Set([
  '-delete',
  '-exec',
  '-execdir',
  '-ok',
  '-okdir',
  '-fprint',
  '-fprintf',
])
const UNIQ_VALUED_FLAGS = new Set([
  '-f',
  '-s',
  '-w',
  '--skip-fields',
  '--skip-chars',
  '--check-chars',
])
const UNIQ_WRITING_OPERANDS = 2

const COMMAND_SUBSTITUTION_RE = /\$\(|`|<\(/u
const WHITESPACE_RE = /\s+/u
const FD_TARGET_RE = /^\d+-?$/u
const SORT_OUTPUT_FLAG_RE = /^-[a-zA-Z]*o$/u
const CAMEL_BOUNDARY_RE = /(?<lower>[a-z\d])(?<upper>[A-Z])/gu

export const MCP_TOOL_PREFIX = 'mcp__'
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
  | { readonly kind: 'mcp'; readonly server: string; readonly hint: GlanceHint | undefined }

export interface ToolCallArguments {
  readonly path: string | undefined
  readonly pattern: string | undefined
  readonly command: string | undefined
  readonly query: string | undefined
}

type ShellCommandKind = 'search' | 'read' | 'list'
type CommandClass = ShellCommandKind | 'writes' | 'ignored'

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

function writesThroughArguments(base: string, words: readonly string[]): boolean {
  const args = words.slice(1)
  if (base === 'sort') {
    return args.some((word) => word.startsWith('--output') || SORT_OUTPUT_FLAG_RE.test(word))
  }
  if (base !== 'uniq') {
    return false
  }
  let operands = 0
  for (let index = 0; index < args.length; index += 1) {
    const word = args[index] ?? ''
    if (UNIQ_VALUED_FLAGS.has(word)) {
      index += 1
    } else if (!word.startsWith('-') || word === '-') {
      operands += 1
    }
  }
  return operands >= UNIQ_WRITING_OPERANDS
}

function operatorAt(command: string, index: number): string | undefined {
  return MULTI_CHAR_OPERATORS.find((operator) => command.startsWith(operator, index))
}

function splitCommandWithOperators(command: string): string[] | undefined {
  const parts: string[] = []
  let current = ''
  let quote: string | undefined = undefined
  let index = 0

  function flush(): void {
    const trimmed = current.trim()
    if (trimmed !== '') {
      parts.push(trimmed)
    }
    current = ''
  }

  while (index < command.length) {
    const char = command[index] ?? ''
    const operator = quote === undefined ? operatorAt(command, index) : undefined
    if (quote !== undefined) {
      current += char
      if (char === quote) {
        quote = undefined
      }
      index += 1
    } else if (char === '"' || char === "'") {
      quote = char
      current += char
      index += 1
    } else if (char === '\\' && index + 1 < command.length) {
      current += char + (command[index + 1] ?? '')
      index += 2
    } else if (operator !== undefined) {
      flush()
      parts.push(operator)
      index += operator.length
    } else if (SINGLE_CHAR_OPERATORS.has(char)) {
      flush()
      parts.push(char)
      index += 1
    } else {
      current += char
      index += 1
    }
  }
  if (quote !== undefined) {
    return undefined
  }
  flush()
  return parts
}

function isHarmlessRedirect(operator: string, target: string): boolean {
  if (!WRITE_REDIRECT_OPERATORS.has(operator)) {
    return true
  }
  const word = target.split(WHITESPACE_RE)[0] ?? ''
  if (FD_DUP_OPERATORS.has(operator) && FD_TARGET_RE.test(word)) {
    return true
  }
  return word === NULL_DEVICE
}

function classifyCommandWord(part: string): CommandClass {
  const words = part.split(WHITESPACE_RE)
  const base = words[0]
  if (base === undefined || base === '' || BASH_NEUTRAL_COMMANDS.has(base)) {
    return 'ignored'
  }
  if (base === 'find' && words.some((word) => FIND_MUTATING_FLAGS.has(word))) {
    return 'writes'
  }
  if (writesThroughArguments(base, words)) {
    return 'writes'
  }
  if (BASH_SEARCH_COMMANDS.has(base)) {
    return 'search'
  }
  if (BASH_READ_COMMANDS.has(base)) {
    return 'read'
  }
  return BASH_LIST_COMMANDS.has(base) ? 'list' : 'writes'
}

function classifyShellCommand(command: string): ShellCommandKind | undefined {
  if (COMMAND_SUBSTITUTION_RE.test(command)) {
    return undefined
  }
  const parts = splitCommandWithOperators(command)
  if (parts === undefined || parts.length === 0) {
    return undefined
  }
  const kinds = new Set<ShellCommandKind>()
  let redirect: string | undefined = undefined
  for (const part of parts) {
    if (redirect !== undefined) {
      const operator = redirect
      redirect = undefined
      if (!isHarmlessRedirect(operator, part)) {
        return undefined
      }
    } else if (REDIRECT_OPERATORS.has(part)) {
      redirect = part
    } else if (!SEPARATOR_OPERATORS.has(part)) {
      const commandClass = classifyCommandWord(part)
      if (commandClass === 'writes') {
        return undefined
      }
      if (commandClass !== 'ignored') {
        kinds.add(commandClass)
      }
    }
  }
  if (redirect !== undefined && WRITE_REDIRECT_OPERATORS.has(redirect)) {
    return undefined
  }
  if (kinds.has('search')) {
    return 'search'
  }
  if (kinds.has('read')) {
    return 'read'
  }
  return kinds.has('list') ? 'list' : undefined
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

function classifyShellCall(command: string, prompt: string): ToolGlance | undefined {
  const comment = leadingComment(command)
  const body = stripLeadingComments(command)
  const kind = classifyShellCommand(body)
  if (kind === undefined) {
    return undefined
  }
  const hint: GlanceHint =
    comment === undefined
      ? { kind: 'command', text: compactCommand(body), prompt }
      : { kind: 'comment', text: comment }
  return kind === 'read' ? { kind, path: undefined, hint } : { kind, hint }
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
