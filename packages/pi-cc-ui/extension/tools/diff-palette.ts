import type { Theme } from '@earendil-works/pi-coding-agent'

import {
  bgSgr,
  dimmerIndexedBgSgr,
  fgSgr,
  fgSgrToBgSgr,
  hexToRgb,
  isLightTheme,
  mixRgb,
  sgrToRgb,
  themeName,
} from '../ansi.js'
import type { Rgb } from '../ansi.js'
import { cacheKey, KeyedCache } from '../cache.js'

interface DiffPalette {
  readonly added: Rgb
  readonly removed: Rgb
  readonly addedWord: Rgb
  readonly removedWord: Rgb
}

const CLAUDE_DARK: DiffPalette = {
  added: { r: 34, g: 92, b: 43 },
  removed: { r: 122, g: 41, b: 54 },
  addedWord: { r: 56, g: 166, b: 73 },
  removedWord: { r: 179, g: 57, b: 79 },
}

const CLAUDE_LIGHT: DiffPalette = {
  added: { r: 105, g: 219, b: 124 },
  removed: { r: 255, g: 168, b: 180 },
  addedWord: { r: 47, g: 157, b: 68 },
  removedWord: { r: 209, g: 69, b: 75 },
}

const CANVAS_DARK: Rgb = { r: 30, g: 30, b: 30 }
const CANVAS_LIGHT: Rgb = { r: 255, g: 255, b: 255 }
const DERIVED_WASH_DARK = 0.5
const DERIVED_WASH_LIGHT = 0.45
const LINE_NUMBER_DARK = '#646464'
const LINE_NUMBER_LIGHT = '#999999'
const DALTONIZED_THEME_RE = /daltonized/iu

export interface DiffSgr {
  readonly addedBg: string
  readonly removedBg: string
  readonly addedWordBg: string
  readonly removedWordBg: string
  readonly lineNumberFg: string
}

const diffSgrCache = new KeyedCache<DiffSgr>()

function derivedPalette(addedWord: Rgb, removedWord: Rgb, light: boolean): DiffPalette {
  const canvas = light ? CANVAS_LIGHT : CANVAS_DARK
  const wash = light ? DERIVED_WASH_LIGHT : DERIVED_WASH_DARK
  return {
    added: mixRgb(addedWord, canvas, wash),
    removed: mixRgb(removedWord, canvas, wash),
    addedWord,
    removedWord,
  }
}

function buildDiffSgr(theme: Theme): DiffSgr {
  const mode = theme.getColorMode()
  const light = isLightTheme(theme)
  const lineNumberFg = fgSgr(hexToRgb(light ? LINE_NUMBER_LIGHT : LINE_NUMBER_DARK), mode)
  const added = theme.getFgAnsi('toolDiffAdded')
  const removed = theme.getFgAnsi('toolDiffRemoved')
  const addedRgb = sgrToRgb(added)
  const removedRgb = sgrToRgb(removed)
  if (addedRgb === undefined || removedRgb === undefined) {
    return {
      addedBg: dimmerIndexedBgSgr(added),
      removedBg: dimmerIndexedBgSgr(removed),
      addedWordBg: fgSgrToBgSgr(added),
      removedWordBg: fgSgrToBgSgr(removed),
      lineNumberFg,
    }
  }
  let palette = light ? CLAUDE_LIGHT : CLAUDE_DARK
  if (DALTONIZED_THEME_RE.test(themeName(theme))) {
    palette = derivedPalette(addedRgb, removedRgb, light)
  }
  return {
    addedBg: bgSgr(palette.added, mode),
    removedBg: bgSgr(palette.removed, mode),
    addedWordBg: bgSgr(palette.addedWord, mode),
    removedWordBg: bgSgr(palette.removedWord, mode),
    lineNumberFg,
  }
}

export function diffSgr(theme: Theme): DiffSgr {
  const key = cacheKey(
    themeName(theme),
    theme.getColorMode(),
    theme.getFgAnsi('toolDiffAdded'),
    theme.getFgAnsi('toolDiffRemoved'),
  )
  return diffSgrCache.get(key, () => buildDiffSgr(theme))
}
