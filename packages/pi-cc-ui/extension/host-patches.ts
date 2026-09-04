import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  AssistantMessageComponent,
  InteractiveMode,
  ToolExecutionComponent,
  UserMessageComponent,
} from '@earendil-works/pi-coding-agent'
import type { Component } from '@earendil-works/pi-tui'
import {
  Box,
  Markdown,
  stripTerminalSequences,
  Text,
  TruncatedText,
  TuiAltScreen,
} from '@earendil-works/pi-tui'

import type { PaintText } from './ansi.js'
import { isRecord } from './guards.js'
import type { Settings } from './settings.js'
import type { ThinkingVisibility } from './thinking.js'
import type { ToolGroups } from './tools/groups.js'
import type { ToolRenderer } from './tools/row.js'
import { createToolShellRender } from './tools/tool-shell.js'
import type { ToolShellOptions } from './tools/tool-shell.js'

const PATCH_OWNER_FLAG = Symbol.for('pi-cc-ui:host-patch')

const TOOL_OUTPUT_STATUS_RE = /^Tool output: (?:expanded|collapsed)$/u

const USER_PREFIX = '❯ '
const USER_PREFIX_PAD = '  '

export const HOST_HARDCODED_PAD = 1

type Restore = () => void
type HostMethod = (...args: never[]) => unknown
type RenderMethod = (this: object, width: number) => string[]
type WheelMethod = (this: object, event: unknown) => unknown
type ShowStatusMethod = (this: InteractiveMode, message: unknown) => unknown
type RebuildMethod = (this: UserMessageComponent) => void
type UpdateContentMethod = (this: object, ...args: unknown[]) => unknown
type ThinkingVisibilityMethod = (this: object) => void

interface OriginalMethod {
  readonly value: HostMethod
  readonly own: boolean
}

interface PaddedBox {
  paddingY: number
  children: Component[]
  invalidateCache: () => void
}

function isBlankRow(line: string): boolean {
  return stripTerminalSequences(line).trim() === ''
}

function isPaddedBox(value: unknown): value is PaddedBox {
  return (
    isRecord(value) &&
    typeof value['paddingY'] === 'number' &&
    Array.isArray(value['children']) &&
    typeof value['invalidateCache'] === 'function'
  )
}

class PrefixedComponent implements Component {
  private readonly inner: Component
  private readonly paintPrefix: PaintText

  constructor(inner: Component, paintPrefix: PaintText) {
    this.inner = inner
    this.paintPrefix = paintPrefix
  }

  render(width: number): string[] {
    const lines = this.inner.render(Math.max(1, width - USER_PREFIX_PAD.length))
    const prefix = this.paintPrefix(USER_PREFIX)
    return lines.map((line, index) => (index === 0 ? prefix : USER_PREFIX_PAD) + line)
  }

  invalidate(): void {
    this.inner.invalidate()
  }
}

function isHostMethod(value: unknown): value is HostMethod {
  return typeof value === 'function'
}

function findOriginal(target: object, key: PropertyKey): OriginalMethod | undefined {
  let holder: object | null = target
  while (holder !== null) {
    const descriptor: { value?: unknown } | undefined = Object.getOwnPropertyDescriptor(holder, key)
    if (descriptor !== undefined) {
      const value: unknown = descriptor.value
      if (!isHostMethod(value) || PATCH_OWNER_FLAG in value) {
        return undefined
      }
      return { value, own: holder === target }
    }
    holder = Reflect.getPrototypeOf(holder)
  }
  return undefined
}

function defineMethod(target: object, key: PropertyKey, value: HostMethod): void {
  Object.defineProperty(target, key, { value, writable: true, configurable: true })
}

function installMethod(
  target: object,
  key: PropertyKey,
  original: OriginalMethod,
  replacement: HostMethod,
): Restore {
  Object.defineProperty(replacement, PATCH_OWNER_FLAG, { value: true, configurable: true })
  defineMethod(target, key, replacement)
  return () => {
    const current: { value?: unknown } | undefined = Object.getOwnPropertyDescriptor(target, key)
    if (current?.value !== replacement) {
      return
    }
    if (original.own) {
      defineMethod(target, key, original.value)
    } else {
      Reflect.deleteProperty(target, key)
    }
  }
}

function isRenderMethod(value: unknown): value is RenderMethod {
  return typeof value === 'function'
}

function isShowStatusMethod(value: unknown): value is ShowStatusMethod {
  return typeof value === 'function'
}

function isRebuildMethod(value: unknown): value is RebuildMethod {
  return typeof value === 'function'
}

function patchAssistantBlankRows(): Restore | undefined {
  const proto: object = AssistantMessageComponent.prototype
  const found = findOriginal(proto, 'render')
  if (found === undefined || !isRenderMethod(found.value)) {
    return undefined
  }
  const original = found.value
  return installMethod(
    proto,
    'render',
    found,
    function render(this: object, width: number): string[] {
      const lines = original.call(this, width)
      let blank = 0
      while (blank < lines.length && isBlankRow(lines[blank] ?? '')) {
        blank += 1
      }
      if (blank === lines.length) {
        return []
      }
      if (blank > 1) {
        lines.splice(1, blank - 1)
      }
      return lines
    },
  )
}

function patchToolOutputStatus(): Restore | undefined {
  const proto: object = InteractiveMode.prototype
  const found = findOriginal(proto, 'showStatus')
  if (found === undefined || !isShowStatusMethod(found.value)) {
    return undefined
  }
  const original = found.value
  return installMethod(
    proto,
    'showStatus',
    found,
    function showStatus(this: InteractiveMode, message: unknown): unknown {
      if (typeof message === 'string' && TOOL_OUTPUT_STATUS_RE.test(message)) {
        return undefined
      }
      return original.call(this, message)
    },
  )
}

function patchUserMessagePrefix(paintPrefix: PaintText): Restore | undefined {
  const proto: object = UserMessageComponent.prototype
  const found = findOriginal(proto, 'rebuild')
  if (found === undefined || !isRebuildMethod(found.value)) {
    return undefined
  }
  const original = found.value
  return installMethod(proto, 'rebuild', found, function rebuild(this: UserMessageComponent): void {
    original.call(this)
    const box = this.children[0]
    if (!isPaddedBox(box)) {
      return
    }
    box.paddingY = 0
    const inner = box.children[0]
    if (inner !== undefined && !(inner instanceof PrefixedComponent)) {
      box.children[0] = new PrefixedComponent(inner, paintPrefix)
    }
    box.invalidateCache()
  })
}

function isUpdateContentMethod(value: unknown): value is UpdateContentMethod {
  return typeof value === 'function'
}

function isThinkingVisibilityMethod(value: unknown): value is ThinkingVisibilityMethod {
  return typeof value === 'function'
}

function patchThinkingMarkdownPath(): Restore | undefined {
  const proto: object = AssistantMessageComponent.prototype
  const found = findOriginal(proto, 'updateContent')
  if (found === undefined || !isUpdateContentMethod(found.value)) {
    return undefined
  }
  const original = found.value
  return installMethod(
    proto,
    'updateContent',
    found,
    function updateContent(this: object, ...args: unknown[]): unknown {
      if (!isRecord(this) || this['hideThinkingBlock'] !== true) {
        return original.call(this, ...args)
      }
      this['hideThinkingBlock'] = false
      try {
        return original.call(this, ...args)
      } finally {
        this['hideThinkingBlock'] = true
      }
    },
  )
}

function patchThinkingToggleBridge(setExpanded: (expanded: boolean) => void): Restore | undefined {
  const proto: object = InteractiveMode.prototype
  const found = findOriginal(proto, 'updateThinkingBlockVisibility')
  if (found === undefined || !isThinkingVisibilityMethod(found.value)) {
    return undefined
  }
  const original = found.value
  return installMethod(
    proto,
    'updateThinkingBlockVisibility',
    found,
    function updateThinkingBlockVisibility(this: object): void {
      if (isRecord(this)) {
        const hide = this['hideThinkingBlock']
        if (typeof hide === 'boolean') {
          setExpanded(!hide)
        }
      }
      original.call(this)
    },
  )
}

function patchPaddedRender(proto: object, columns: number): Restore | undefined {
  const found = findOriginal(proto, 'render')
  if (found === undefined || !isRenderMethod(found.value)) {
    return undefined
  }
  const original = found.value
  return installMethod(
    proto,
    'render',
    found,
    function render(this: object, width: number): string[] {
      if (!isRecord(this)) {
        return original.call(this, width)
      }
      const paddingX = this['paddingX']
      if (typeof paddingX !== 'number' || paddingX <= 0) {
        return original.call(this, width)
      }
      this['paddingX'] = Math.max(0, paddingX - columns)
      try {
        return original.call(this, width)
      } finally {
        this['paddingX'] = paddingX
      }
    },
  )
}

function isWheelMethod(value: unknown): value is WheelMethod {
  return typeof value === 'function'
}

function patchWheelScroll(lines: number): Restore | undefined {
  const proto: object = TuiAltScreen.prototype
  const found = findOriginal(proto, 'routeWheel')
  if (found === undefined || !isWheelMethod(found.value)) {
    return undefined
  }
  const original = found.value
  return installMethod(
    proto,
    'routeWheel',
    found,
    function routeWheel(this: object, event: unknown): unknown {
      if (!isRecord(this)) {
        return original.call(this, event)
      }
      const previous = this['wheelScrollLines']
      if (typeof previous !== 'number') {
        return original.call(this, event)
      }
      this['wheelScrollLines'] = lines
      try {
        return original.call(this, event)
      } finally {
        this['wheelScrollLines'] = previous
      }
    },
  )
}

function patchToolShell(options: ToolShellOptions): Restore | undefined {
  const proto: object = ToolExecutionComponent.prototype
  const found = findOriginal(proto, 'render')
  if (found === undefined || !isRenderMethod(found.value)) {
    return undefined
  }
  return installMethod(proto, 'render', found, createToolShellRender(options, found.value))
}

export interface HostPatchOptions {
  readonly settings: Settings
  readonly groups: ToolGroups
  readonly renderers: ReadonlyMap<string, ToolRenderer>
  readonly thinking: ThinkingVisibility
}

export function installHostPatches(pi: ExtensionAPI, options: HostPatchOptions): void {
  const settings = options.settings
  const groups = options.groups
  const renderers = options.renderers
  const thinking = options.thinking
  let installed: Restore[] = []

  function uninstall(): void {
    for (const restore of installed.toReversed()) {
      restore()
    }
    installed = []
  }

  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') {
      return
    }
    uninstall()

    const theme = ctx.ui.theme

    function paintUserPrefix(text: string): string {
      return theme.fg('userMessageText', text)
    }

    function setThinkingExpanded(expanded: boolean): void {
      thinking.setExpanded(expanded)
    }

    const patches: (Restore | undefined)[] = [
      patchAssistantBlankRows(),
      patchToolOutputStatus(),
      patchUserMessagePrefix(paintUserPrefix),
      patchThinkingMarkdownPath(),
      patchThinkingToggleBridge(setThinkingExpanded),
      patchWheelScroll(settings.wheelScrollLines()),
      patchToolShell({
        getTheme: () => theme,
        ui: { settings, groups },
        renderers,
        getAllTools: () => pi.getAllTools(),
      }),
    ]
    const padShift = HOST_HARDCODED_PAD - settings.outputPad()
    if (padShift !== 0) {
      for (const component of [Text, Markdown, Box, TruncatedText]) {
        patches.push(patchPaddedRender(component.prototype, padShift))
      }
    }
    installed = patches.flatMap((restore) => (restore === undefined ? [] : [restore]))
  })

  pi.on('session_shutdown', uninstall)
}
