import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { getAgentDir, SettingsManager } from '@earendil-works/pi-coding-agent'

import { isRecord, isUnknownArray } from './guards.js'

const PREFERENCES_FILE = 'pi-cc-ui.json'
const TOOL_GROUPING_PREFERENCE = 'groupToolCalls'
const THINKING_MODE_PREFERENCE = 'thinkingMode'
const WHEEL_SCROLL_LINES_PREFERENCE = 'wheelScrollLines'
const DEFAULT_WHEEL_SCROLL_LINES = 3
const JSON_INDENT = 2

interface SettingsScope {
  readonly cwd: string
  readonly projectTrusted: boolean
}

type Preferences = Record<string, unknown>

export type ThinkingMode = 'live' | 'full'

function isPreferences(value: unknown): value is Preferences {
  return isRecord(value) && !isUnknownArray(value)
}

function readPreferencesFile(path: string): Preferences | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isPreferences(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export class Settings {
  private scope: SettingsScope = { cwd: process.cwd(), projectTrusted: false }
  private manager: SettingsManager | undefined = undefined
  private preferences: Preferences | undefined = undefined

  constructor(pi: ExtensionAPI) {
    pi.on('session_start', (_event, ctx) => {
      this.useScope({ cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted() })
    })
    pi.on('session_shutdown', () => {
      this.useScope({ cwd: process.cwd(), projectTrusted: false })
    })
  }

  outputPad(): number {
    return this.hostSettings().getOutputPad()
  }

  extensionPaths(): readonly string[] {
    return this.hostSettings().getExtensionPaths()
  }

  packageSources(): readonly string[] {
    return this.hostSettings()
      .getPackages()
      .map((pkg) => (typeof pkg === 'string' ? pkg : pkg.source))
  }

  isToolGroupingEnabled(): boolean {
    return this.booleanPreference(TOOL_GROUPING_PREFERENCE, true)
  }

  setToolGroupingEnabled(enabled: boolean): void {
    this.writePreference(TOOL_GROUPING_PREFERENCE, enabled)
  }

  thinkingMode(): ThinkingMode {
    return this.readPreferences()[THINKING_MODE_PREFERENCE] === 'full' ? 'full' : 'live'
  }

  setThinkingMode(mode: ThinkingMode): void {
    this.writePreference(THINKING_MODE_PREFERENCE, mode)
  }

  wheelScrollLines(): number {
    const value = this.readPreferences()[WHEEL_SCROLL_LINES_PREFERENCE]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
      return DEFAULT_WHEEL_SCROLL_LINES
    }
    return Math.floor(value)
  }

  private useScope(scope: SettingsScope): void {
    this.scope = scope
    this.manager = undefined
    this.preferences = undefined
  }

  private hostSettings(): SettingsManager {
    this.manager ??= SettingsManager.create(this.scope.cwd, getAgentDir(), {
      projectTrusted: this.scope.projectTrusted,
    })
    return this.manager
  }

  private readPreferences(): Preferences {
    this.preferences ??= readPreferencesFile(join(getAgentDir(), PREFERENCES_FILE)) ?? {}
    return this.preferences
  }

  private booleanPreference(key: string, fallback: boolean): boolean {
    const value = this.readPreferences()[key]
    return typeof value === 'boolean' ? value : fallback
  }

  private writePreference(key: string, value: boolean | ThinkingMode): void {
    const updated = { ...this.readPreferences(), [key]: value }
    this.preferences = updated
    mkdirSync(getAgentDir(), { recursive: true })
    writeFileSync(
      join(getAgentDir(), PREFERENCES_FILE),
      `${JSON.stringify(updated, null, JSON_INDENT)}\n`,
    )
  }
}
