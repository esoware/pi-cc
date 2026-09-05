import type { ExtensionAPI, ExtensionContext, Theme } from '@earendil-works/pi-coding-agent'
import { visibleWidth } from '@earendil-works/pi-tui'

import { createBlendedPaint } from './ansi.js'
import type { PaintText } from './ansi.js'
import { formatDuration, formatTokenCount } from './format.js'

const SPINNER_FRAMES = ['⬩', '⬦', '⬥', '⬨', '⬧', '⬨', '⬥', '⬦', '⬩']
const FALLBACK_GLYPH = '⬥'

const FRAME_MS = 120
const TICK_MS = 50
const GLIMMER_MS = 200
const GLIMMER_PAUSE_MS = 500
const MS_PER_SECOND = 1000

const VERB = 'Working'
const THINKING_LABEL = 'thinking'

const THINKING_GLOW_DELAY_MS = 3000
const THINKING_GLOW_PERIOD_S = 2
const FULL_TURN = Math.PI * 2
const SINE_RANGE = 2

const THINKING_ALMOST_DONE_MS = 120_000
const THINKING_SOME_MORE_MS = 60_000
const THINKING_MORE_MS = 30_000
const THINKING_SETTLED_VISIBLE_MS = 2000
const THINKING_SETTLED_DELAY_MS = 2000

const GLIMMER_SPAN = 1
const GLYPH_COLS = 2
const BYLINE_MARGIN_COLS = 5
const BYLINE_SEPARATOR_COLS = 3

const DEFAULT_COLUMNS = 80

type Timer = ReturnType<typeof setTimeout>
type Interval = ReturnType<typeof setInterval>

type ThinkingState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'thinking'; readonly startedAt: number }
  | { readonly kind: 'closing' }
  | { readonly kind: 'settled'; readonly durationMs: number }

interface SpinnerPaint {
  readonly accent: PaintText
  readonly shimmer: PaintText
  readonly dim: PaintText
  readonly glow: (weight: number) => PaintText
}

interface ThinkingDisplay {
  readonly label: string
  readonly shortLabel: string | undefined
  readonly active: boolean
}

interface SpinnerFrame {
  readonly elapsedMs: number
  readonly columns: number
  readonly tokens: number
  readonly thinking: ThinkingDisplay | undefined
}

function paintFor(theme: Theme): SpinnerPaint {
  return {
    accent: (text) => theme.fg('borderAccent', text),
    shimmer: (text) => theme.fg('customMessageLabel', text),
    dim: (text) => theme.fg('dim', text),
    glow: (weight) => createBlendedPaint(theme, 'dim', 'muted', weight),
  }
}

function glimmerIndexFor(elapsedMs: number, messageWidth: number): number {
  const sweepSteps = messageWidth + GLIMMER_SPAN * 2
  const legMs = sweepSteps * GLIMMER_MS + GLIMMER_PAUSE_MS
  const legIndex = Math.floor(elapsedMs / legMs)
  const step = Math.min(sweepSteps, Math.floor((elapsedMs % legMs) / GLIMMER_MS))

  return legIndex % 2 === 0 ? messageWidth + GLIMMER_SPAN - 1 - step : step - GLIMMER_SPAN
}

function glimmerMessage(message: string, glimmerIndex: number, paint: SpinnerPaint): string {
  const messageWidth = visibleWidth(message)
  const shimmerStart = glimmerIndex - GLIMMER_SPAN
  const shimmerEnd = glimmerIndex + GLIMMER_SPAN
  if (shimmerStart >= messageWidth || shimmerEnd < 0) {
    return paint.accent(message)
  }

  const clampedStart = Math.max(0, shimmerStart)
  let before = ''
  let shimmer = ''
  let after = ''
  let column = 0
  for (const char of message) {
    if (column + 1 <= clampedStart) {
      before += char
    } else if (column > shimmerEnd) {
      after += char
    } else {
      shimmer += char
    }
    column += 1
  }
  return (
    (before === '' ? '' : paint.accent(before)) +
    (shimmer === '' ? '' : paint.shimmer(shimmer)) +
    (after === '' ? '' : paint.accent(after))
  )
}

function thinkingGlowWeight(elapsedMs: number): number {
  if (elapsedMs < THINKING_GLOW_DELAY_MS) {
    return 0
  }
  const phase =
    ((elapsedMs - THINKING_GLOW_DELAY_MS) / MS_PER_SECOND / THINKING_GLOW_PERIOD_S) * FULL_TURN
  return (Math.sin(phase) + 1) / SINE_RANGE
}

function thinkingWording(blockElapsedMs: number): string {
  if (blockElapsedMs >= THINKING_ALMOST_DONE_MS) {
    return 'almost done thinking'
  }
  if (blockElapsedMs >= THINKING_SOME_MORE_MS) {
    return 'thinking some more'
  }
  return blockElapsedMs >= THINKING_MORE_MS ? 'thinking more' : THINKING_LABEL
}

function thinkingDisplay(state: ThinkingState, effortSuffix: string): ThinkingDisplay | undefined {
  switch (state.kind) {
    case 'idle': {
      return undefined
    }
    case 'thinking':
    case 'closing': {
      const elapsedMs = state.kind === 'thinking' ? Date.now() - state.startedAt : 0
      return {
        label: `${thinkingWording(elapsedMs)}${effortSuffix}`,
        shortLabel: effortSuffix === '' ? undefined : THINKING_LABEL,
        active: true,
      }
    }
    case 'settled': {
      const seconds = Math.max(1, Math.round(state.durationMs / MS_PER_SECOND))
      return { label: `thought for ${seconds}s`, shortLabel: undefined, active: false }
    }
  }
}

function effortSuffixFor(level: string): string {
  return level === '' || level === 'none' || level === 'off' ? '' : ` with ${level} effort`
}

function buildSpinnerLine(frame: SpinnerFrame, paint: SpinnerPaint): string {
  const message = `${VERB}…`
  const messageWidth = visibleWidth(message)
  const frameIndex = Math.floor(frame.elapsedMs / FRAME_MS) % SPINNER_FRAMES.length
  const glyph = paint.accent(SPINNER_FRAMES[frameIndex] ?? FALLBACK_GLYPH)

  const glimmerIndex = glimmerIndexFor(frame.elapsedMs, messageWidth)
  const verbSpan = glimmerMessage(message, glimmerIndex, paint)

  const thinking = frame.thinking
  const timerText = formatDuration(frame.elapsedMs)
  const tokensText = frame.tokens > 0 ? `↓ ${formatTokenCount(frame.tokens)} tokens` : undefined

  const availableSpace = frame.columns - (GLYPH_COLS + messageWidth) - BYLINE_MARGIN_COLS
  let thinkingText = thinking?.label
  let thinkingWidth = thinkingText === undefined ? 0 : visibleWidth(thinkingText)
  let showThinking = thinkingText !== undefined && availableSpace > thinkingWidth
  const shortLabel = thinking?.shortLabel
  if (!showThinking && shortLabel !== undefined && availableSpace > visibleWidth(shortLabel)) {
    thinkingText = shortLabel
    thinkingWidth = visibleWidth(shortLabel)
    showThinking = true
  }
  const usedAfterThinking = showThinking ? thinkingWidth + BYLINE_SEPARATOR_COLS : 0
  const showTimer = availableSpace > usedAfterThinking + visibleWidth(timerText)
  const usedAfterTimer =
    usedAfterThinking + (showTimer ? visibleWidth(timerText) + BYLINE_SEPARATOR_COLS : 0)
  const showTokens =
    tokensText !== undefined && availableSpace > usedAfterTimer + visibleWidth(tokensText)

  const active = thinking?.active === true
  const thinkingPaint = active ? paint.glow(thinkingGlowWeight(frame.elapsedMs)) : paint.dim
  const shownThinking = showThinking ? thinkingText : undefined
  const parts: string[] = []
  if (showTimer) {
    parts.push(paint.dim(timerText))
  }
  if (showTokens) {
    parts.push(paint.dim(tokensText))
  }
  if (shownThinking !== undefined) {
    parts.push(thinkingPaint(shownThinking))
  }

  let byline = ''
  if (parts.length > 0) {
    byline =
      shownThinking !== undefined && active && !showTimer && !showTokens
        ? ` ${thinkingPaint(`(${shownThinking})`)}`
        : ` ${paint.dim('(')}${parts.join(paint.dim(' · '))}${paint.dim(')')}`
  }
  return `${glyph} ${verbSpan}${byline}`
}

function terminalColumns(): number {
  const columns = process.stdout.columns
  return Number.isFinite(columns) ? columns : DEFAULT_COLUMNS
}

export function registerSpinner(pi: ExtensionAPI): void {
  let animationStartedAt = 0
  let animationTimer: Interval | undefined = undefined
  let settledTokens = 0
  let streamTokens = 0
  let effortSuffix = ''
  let thinking: ThinkingState = { kind: 'idle' }
  let thinkingTimer: Timer | undefined = undefined

  function clearThinkingTimer(): void {
    if (thinkingTimer !== undefined) {
      clearTimeout(thinkingTimer)
      thinkingTimer = undefined
    }
  }

  function delayThinking(delayMs: number, next: () => void): void {
    const timer = setTimeout(() => {
      thinkingTimer = undefined
      next()
    }, delayMs)
    timer.unref()
    thinkingTimer = timer
  }

  function showSettledThinking(durationMs: number): void {
    thinking = { kind: 'settled', durationMs }
    delayThinking(THINKING_SETTLED_VISIBLE_MS, () => {
      thinking = { kind: 'idle' }
    })
  }

  function beginThinking(): void {
    if (thinking.kind === 'thinking') {
      return
    }
    clearThinkingTimer()
    thinking = { kind: 'thinking', startedAt: Date.now() }
  }

  function settleThinking(): void {
    if (thinking.kind !== 'thinking') {
      return
    }
    const durationMs = Date.now() - thinking.startedAt
    const remainingMs = Math.max(0, THINKING_SETTLED_DELAY_MS - durationMs)
    if (remainingMs === 0) {
      showSettledThinking(durationMs)
      return
    }
    thinking = { kind: 'closing' }
    delayThinking(remainingMs, () => {
      showSettledThinking(durationMs)
    })
  }

  function stopAnimation(): void {
    if (animationTimer !== undefined) {
      clearInterval(animationTimer)
      animationTimer = undefined
    }
  }

  function repaint(ctx: ExtensionContext): void {
    if (ctx.mode !== 'tui' || animationTimer === undefined) {
      return
    }
    const line = buildSpinnerLine(
      {
        elapsedMs: Date.now() - animationStartedAt,
        columns: terminalColumns(),
        tokens: settledTokens + streamTokens,
        thinking: thinkingDisplay(thinking, effortSuffix),
      },
      paintFor(ctx.ui.theme),
    )
    ctx.ui.setWorkingMessage(line)
  }

  function resetRun(): void {
    stopAnimation()
    clearThinkingTimer()
    animationStartedAt = 0
    settledTokens = 0
    streamTokens = 0
    effortSuffix = ''
    thinking = { kind: 'idle' }
  }

  pi.on('session_start', (_event, ctx) => {
    resetRun()
    if (!ctx.hasUI) {
      return
    }
    if (ctx.mode === 'tui') {
      ctx.ui.setWorkingIndicator({ frames: [] })
    }
    ctx.ui.setTitle(`✻ ${ctx.cwd}`)
  })

  pi.on('session_shutdown', resetRun)

  pi.on('agent_start', (_event, ctx) => {
    resetRun()
    animationStartedAt = Date.now()
    if (ctx.mode !== 'tui') {
      return
    }
    const timer = setInterval(() => {
      repaint(ctx)
    }, TICK_MS)
    timer.unref()
    animationTimer = timer
    repaint(ctx)
  })

  pi.on('message_update', (event, ctx) => {
    const update = event.assistantMessageEvent
    if ('partial' in update) {
      streamTokens = update.partial.usage.output
    }
    if (update.type === 'thinking_start') {
      effortSuffix = effortSuffixFor(ctx.thinkingLevel ?? '')
      beginThinking()
    } else if (update.type === 'thinking_end') {
      settleThinking()
    }
  })

  pi.on('message_end', (event) => {
    if (event.message.role !== 'assistant') {
      return
    }
    settledTokens += event.message.usage.output
    streamTokens = 0
    settleThinking()
  })

  pi.on('agent_settled', (_event, ctx) => {
    stopAnimation()
    clearThinkingTimer()
    if (ctx.mode === 'tui') {
      ctx.ui.setWorkingMessage()
    }
  })
}
