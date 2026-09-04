import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent'

export const ESC = '\u001B'

const CSI = `${ESC}[`

export const RESET = `${CSI}0m`
export const BOLD = `${CSI}1m`
export const DIM = `${CSI}2m`
export const ITALIC = `${CSI}3m`
const FG_DEFAULT = `${CSI}39m`
export const BG_DEFAULT = `${CSI}49m`

const NORMAL_INTENSITY = `${CSI}22m`
const NOT_ITALIC = `${CSI}23m`

export type PaintText = (text: string) => string

type ColorMode = ReturnType<Theme['getColorMode']>

export interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

const HEX_RADIX = 16
const HEX_BYTE_DIGITS = 2

const CUBE_LEVEL_COUNT = 6
const CUBE_LEVEL_BASE = 55
const CUBE_LEVEL_STEP = 40
const CUBE_INDEX_BASE = 16
const CUBE_GREEN_STRIDE = CUBE_LEVEL_COUNT
const CUBE_RED_STRIDE = CUBE_LEVEL_COUNT * CUBE_LEVEL_COUNT
const ANSI_BRIGHT_BASE = 8
const GRAY_INDEX_BASE = 232
const GRAY_LEVEL_BASE = 8
const GRAY_LEVEL_STEP = 10
const BLEND_MIDPOINT = 0.5

const CUBE_LEVELS: readonly number[] = Array.from({ length: CUBE_LEVEL_COUNT }, (_, level) =>
  level === 0 ? 0 : CUBE_LEVEL_BASE + CUBE_LEVEL_STEP * level,
)

const TRUECOLOR_SGR_RE = /\u001B\[38;2;(?<r>\d{1,3});(?<g>\d{1,3});(?<b>\d{1,3})m/u
const INDEXED_SGR_RE = /\u001B\[38;5;(?<index>\d{1,3})m/u
const LIGHT_THEME_NAME_RE = /(?:^|[-_ ])light(?:[-_ ]|$)/u

export function dim(text: string): string {
  return `${DIM}${text}${NORMAL_INTENSITY}`
}

export function italic(text: string): string {
  return `${ITALIC}${text}${NOT_ITALIC}`
}

export function themeName(theme: Theme): string {
  return theme.name ?? ''
}

export function isLightTheme(theme: Theme): boolean {
  return LIGHT_THEME_NAME_RE.test(themeName(theme))
}

export function hexToRgb(hex: string): Rgb {
  const digits = hex.replace('#', '')
  function byte(index: number): number {
    const start = index * HEX_BYTE_DIGITS
    return Number.parseInt(digits.slice(start, start + HEX_BYTE_DIGITS), HEX_RADIX)
  }
  return { r: byte(0), g: byte(1), b: byte(2) }
}

export function mixRgb(from: Rgb, to: Rgb, weightOfTo: number): Rgb {
  function lerp(start: number, end: number): number {
    return Math.round(start + (end - start) * weightOfTo)
  }
  return { r: lerp(from.r, to.r), g: lerp(from.g, to.g), b: lerp(from.b, to.b) }
}

function nearestCubeLevel(value: number): number {
  let best = 0
  for (const entry of CUBE_LEVELS.entries()) {
    if (Math.abs(value - entry[1]) < Math.abs(value - (CUBE_LEVELS[best] ?? 0))) {
      best = entry[0]
    }
  }
  return best
}

function rgbToCubeIndex(color: Rgb): number {
  return (
    CUBE_INDEX_BASE +
    CUBE_RED_STRIDE * nearestCubeLevel(color.r) +
    CUBE_GREEN_STRIDE * nearestCubeLevel(color.g) +
    nearestCubeLevel(color.b)
  )
}

function cubeIndexToRgb(index: number): Rgb {
  const offset = index - CUBE_INDEX_BASE
  return {
    r: CUBE_LEVELS[Math.floor(offset / CUBE_RED_STRIDE)] ?? 0,
    g: CUBE_LEVELS[Math.floor(offset / CUBE_GREEN_STRIDE) % CUBE_LEVEL_COUNT] ?? 0,
    b: CUBE_LEVELS[offset % CUBE_LEVEL_COUNT] ?? 0,
  }
}

function grayIndexToRgb(index: number): Rgb {
  const level = GRAY_LEVEL_BASE + GRAY_LEVEL_STEP * (index - GRAY_INDEX_BASE)
  return { r: level, g: level, b: level }
}

export function fgSgr(color: Rgb, mode: ColorMode): string {
  return mode === '256color'
    ? `${CSI}38;5;${rgbToCubeIndex(color)}m`
    : `${CSI}38;2;${color.r};${color.g};${color.b}m`
}

export function bgSgr(color: Rgb, mode: ColorMode): string {
  return mode === '256color'
    ? `${CSI}48;5;${rgbToCubeIndex(color)}m`
    : `${CSI}48;2;${color.r};${color.g};${color.b}m`
}

export function fgSgrToBgSgr(sgr: string): string {
  return sgr === FG_DEFAULT ? BG_DEFAULT : sgr.replace(`${CSI}38;`, `${CSI}48;`)
}

export function dimmerIndexedBgSgr(sgr: string): string {
  const match = INDEXED_SGR_RE.exec(sgr)?.groups?.['index']
  if (match === undefined) {
    return BG_DEFAULT
  }
  const index = Number(match)
  return `${CSI}48;5;${index >= ANSI_BRIGHT_BASE ? index - ANSI_BRIGHT_BASE : index}m`
}

export function sgrToRgb(sgr: string): Rgb | undefined {
  const truecolor = TRUECOLOR_SGR_RE.exec(sgr)?.groups
  if (truecolor !== undefined) {
    return { r: Number(truecolor['r']), g: Number(truecolor['g']), b: Number(truecolor['b']) }
  }
  const index = Number(INDEXED_SGR_RE.exec(sgr)?.groups?.['index'])
  if (index >= GRAY_INDEX_BASE) {
    return grayIndexToRgb(index)
  }
  return index >= CUBE_INDEX_BASE ? cubeIndexToRgb(index) : undefined
}

export function createBlendedPaint(
  theme: Theme,
  from: ThemeColor,
  to: ThemeColor,
  weightOfTo: number,
): PaintText {
  const start = sgrToRgb(theme.getFgAnsi(from))
  const end = sgrToRgb(theme.getFgAnsi(to))
  if (start === undefined || end === undefined) {
    const nearest = weightOfTo < BLEND_MIDPOINT ? from : to
    return (text) => theme.fg(nearest, text)
  }
  const sgr = fgSgr(mixRgb(start, end, weightOfTo), theme.getColorMode())
  return (text) => `${sgr}${text}${FG_DEFAULT}`
}
