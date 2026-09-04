import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import type { ExtensionAPI, Theme } from '@earendil-works/pi-coding-agent'
import { CONFIG_DIR_NAME, getAgentDir, VERSION } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'

import { themeName } from './ansi.js'
import type { PaintText } from './ansi.js'
import { cacheKey, KeyedCache } from './cache.js'
import type { Settings } from './settings.js'

const LOGO_GAP = 2
const MIN_TEXT_WIDTH = 16
const SESSION_ID_PREFIX_LEN = 8
const SKILL_COMMAND_PREFIX = 'skill:'

const PATH_SEPARATORS_RE = /[\\/]+/u
const SOURCE_SCHEME_RE = /^(?:npm|git|file|local):/u
const SCRIPT_EXTENSION_RE = /\.(?:ts|js)$/u
const VERSION_SUFFIX_RE = /@[^@/]+$/u

const PI_LOGO: readonly string[] = ['██████  ', '██  ██  ', '████  ██', '██    ██']
const LOGO_WIDTH = Math.max(...PI_LOGO.map((row) => visibleWidth(row)))

const GENERIC_SOURCE_SEGMENTS = new Set([
  'index',
  'main',
  'extension',
  'extensions',
  'src',
  'dist',
  'lib',
  '.',
  '..',
])

interface BannerSource {
  readonly model: () => string | undefined
  readonly effort: () => string
  readonly title: () => string | undefined
  readonly skills: () => readonly string[]
  readonly extensions: () => readonly string[]
  readonly resumedSessionId: string | undefined
}

function accentPaint(theme: Theme): PaintText {
  return (text) => theme.fg('borderAccent', text)
}

function padRight(text: string, width: number): string {
  const rendered = visibleWidth(text)
  return rendered >= width ? truncateToWidth(text, width, '') : text + ' '.repeat(width - rendered)
}

function readDirectoryEntries(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function skillNames(pi: ExtensionAPI): string[] {
  return pi
    .getCommands()
    .filter((command) => command.source === 'skill')
    .map((command) => command.name.slice(SKILL_COMMAND_PREFIX.length))
    .toSorted()
}

function sourceDisplayName(source: string): string {
  const spec = source.replace(SOURCE_SCHEME_RE, '')
  const segments = spec.split(PATH_SEPARATORS_RE).filter((segment) => segment !== '')
  for (const segment of segments.toReversed()) {
    const base = segment.replace(SCRIPT_EXTENSION_RE, '').replace(VERSION_SUFFIX_RE, '')
    if (!GENERIC_SOURCE_SEGMENTS.has(base)) {
      return base
    }
  }
  return spec
}

function extensionNames(settings: Settings, cwd: string, projectTrusted: boolean): string[] {
  const names = new Set<string>()
  const roots = [join(getAgentDir(), 'extensions')]
  if (projectTrusted) {
    roots.push(join(cwd, CONFIG_DIR_NAME, 'extensions'))
  }
  for (const dir of roots) {
    for (const entry of readDirectoryEntries(dir)) {
      if (SCRIPT_EXTENSION_RE.test(entry)) {
        names.add(entry.replace(SCRIPT_EXTENSION_RE, ''))
      } else if (
        existsSync(join(dir, entry, 'index.ts')) ||
        existsSync(join(dir, entry, 'index.js'))
      ) {
        names.add(entry)
      }
    }
  }
  for (const source of [...settings.extensionPaths(), ...settings.packageSources()]) {
    names.add(sourceDisplayName(source))
  }
  return [...names].toSorted()
}

function packIntoRows(names: readonly string[], width: number): string[] {
  const rows: string[] = []
  let row: string[] = []
  for (const name of names) {
    if (row.length > 0 && visibleWidth([...row, name].join(', ')) > width) {
      rows.push(row.join(', '))
      row = []
    }
    row.push(name)
  }
  if (row.length > 0) {
    rows.push(row.join(', '))
  }
  return rows
}

class BannerComponent {
  private readonly source: BannerSource
  private readonly rows = new KeyedCache<string[]>()

  constructor(source: BannerSource) {
    this.source = source
  }

  render(width: number, theme: Theme): string[] {
    const key = cacheKey(
      width,
      themeName(theme),
      theme.getColorMode(),
      this.source.model() ?? '',
      this.source.effort(),
      this.source.title() ?? '',
      this.source.resumedSessionId ?? '',
    )
    return this.rows.get(key, () => this.renderForWidth(width, theme))
  }

  invalidate(): void {
    this.rows.clear()
  }

  private resumedLine(): string | undefined {
    const resumedSessionId = this.source.resumedSessionId
    if (resumedSessionId === undefined) {
      return undefined
    }
    const title = this.source.title()
    const suffix = title === undefined || title === '' ? '' : ` · ${title}`
    return `resumed ${resumedSessionId}${suffix}`
  }

  private textLines(textWidth: number, theme: Theme): string[] {
    const accent = accentPaint(theme)
    function dim(text: string): string {
      return theme.fg('dim', text)
    }

    const lines: string[] = [`${accent('pi')} ${dim(`v${VERSION}`)}`]

    function labeled(label: string, rows: (width: number) => readonly string[]): void {
      const labelText = `${label}: `
      const hang = visibleWidth(labelText)
      const stacked = textWidth - hang < MIN_TEXT_WIDTH
      const body = rows(stacked ? textWidth : textWidth - hang)
      if (body.length === 0) {
        return
      }
      if (stacked) {
        lines.push(accent(labelText), ...body)
        return
      }
      for (const entry of body.entries()) {
        lines.push(`${entry[0] === 0 ? accent(labelText) : ' '.repeat(hang)}${entry[1]}`)
      }
    }

    function section(label: string, names: readonly string[]): void {
      labeled(label, (width) => packIntoRows(names, width).map((text) => dim(text)))
    }

    const model = this.source.model()
    const effort = this.source.effort()
    const modelRow =
      model === undefined || model === ''
        ? []
        : [`${theme.fg('muted', model)}${effort === '' ? '' : dim(` · ${effort}`)}`]

    labeled('Model', () => modelRow)
    section('Extensions', this.source.extensions())
    section('Skills', this.source.skills())

    const resumed = this.resumedLine()
    if (resumed !== undefined) {
      lines.push(dim(resumed))
    }
    return lines
  }

  private renderForWidth(width: number, theme: Theme): string[] {
    const accent = accentPaint(theme)
    const showLogo = width >= LOGO_WIDTH + LOGO_GAP + MIN_TEXT_WIDTH
    const textWidth = showLogo ? width - LOGO_WIDTH - LOGO_GAP : Math.max(1, width)
    const lines = this.textLines(textWidth, theme)

    const rows: string[] = []
    if (showLogo) {
      const height = Math.max(PI_LOGO.length, lines.length)
      for (let row = 0; row < height; row++) {
        const art = PI_LOGO[row]
        const line = lines[row]
        const text = line === undefined ? '' : truncateToWidth(line, textWidth, '')
        if (text === '') {
          rows.push(art === undefined ? '' : accent(art.trimEnd()))
        } else {
          const logo =
            art === undefined ? ' '.repeat(LOGO_WIDTH) : accent(padRight(art, LOGO_WIDTH))
          rows.push(`${logo}${' '.repeat(LOGO_GAP)}${text}`)
        }
      }
    } else {
      for (const line of lines) {
        rows.push(truncateToWidth(line, textWidth, ''))
      }
    }
    rows.push('')
    return rows
  }
}

export function registerBanner(pi: ExtensionAPI, settings: Settings): void {
  pi.on('session_start', (event, ctx) => {
    if (ctx.mode !== 'tui') {
      return
    }
    const sessionId = ctx.sessionManager.getSessionId().slice(0, SESSION_ID_PREFIX_LEN)
    const resumed = event.reason === 'resume' || event.reason === 'fork'
    const banner = new BannerComponent({
      model: () => ctx.model?.id,
      effort: () => pi.getThinkingLevel(),
      title: () => ctx.sessionManager.getSessionName(),
      skills: () => skillNames(pi),
      extensions: () => extensionNames(settings, ctx.cwd, ctx.isProjectTrusted()),
      resumedSessionId: resumed && sessionId !== '' ? sessionId : undefined,
    })
    ctx.ui.setHeader((_tui, theme) => ({
      render(width: number): string[] {
        return banner.render(width, theme)
      },
      invalidate(): void {
        banner.invalidate()
      },
    }))
  })
}
