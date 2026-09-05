import type { ExtensionAPI, KeybindingsManager } from '@earendil-works/pi-coding-agent'
import { CustomEditor } from '@earendil-works/pi-coding-agent'
import type { EditorTheme, TUI } from '@earendil-works/pi-tui'
import { decodeKittyPrintable, parseKey } from '@earendil-works/pi-tui'

const PROMPT_POINTER = '❯'
const PROMPT_COLUMN = 2

const NON_TEXT_KEY_CODEPOINT = /[\p{Cc}\p{Cs}\uE000-\uF8FF]/u

function isUnrecognizedNonTextKey(data: string): boolean {
  const text = decodeKittyPrintable(data)
  return text !== undefined && NON_TEXT_KEY_CODEPOINT.test(text) && parseKey(data) === undefined
}

class PromptEditor extends CustomEditor {
  constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
    super(tui, theme, keybindings, { paddingX: PROMPT_COLUMN })
  }

  override handleInput(data: string): void {
    if (isUnrecognizedNonTextKey(data)) {
      this.onExtensionShortcut?.(data)
      return
    }
    super.handleInput(data)
  }

  override setPaddingX(padding: number): void {
    super.setPaddingX(Math.max(padding, PROMPT_COLUMN))
  }

  override render(width: number): string[] {
    const rows = super.render(width)
    const firstRow = rows[1]
    const padding = ' '.repeat(PROMPT_COLUMN)
    if (firstRow?.startsWith(padding) === true) {
      rows[1] = `${this.borderColor(PROMPT_POINTER)} ${firstRow.slice(PROMPT_COLUMN)}`
    }
    return rows
  }
}

export function registerPromptEditor(pi: ExtensionAPI): void {
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') {
      return
    }
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) => new PromptEditor(tui, theme, keybindings),
    )
  })
}
