import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

import { registerBanner } from './banner.js'
import { registerCommands } from './commands.js'
import { installHostPatches } from './host-patches.js'
import { registerPromptEditor } from './prompt-editor.js'
import { Settings } from './settings.js'
import { registerSpinner } from './spinner.js'
import { registerStatusLine } from './status-line.js'
import { registerThinking, ThinkingVisibility } from './thinking.js'
import { createBuiltinRenderers } from './tools/builtins.js'
import { ToolGroups } from './tools/groups.js'
import { registerTurnFooter } from './turn-footer.js'

export default function piCcUi(pi: ExtensionAPI): void {
  const settings = new Settings(pi)
  const groups = new ToolGroups(pi, settings)
  const thinking = new ThinkingVisibility()

  const renderers = createBuiltinRenderers(pi, groups)
  installHostPatches(pi, { settings, groups, renderers, thinking })

  registerSpinner(pi)
  registerTurnFooter(pi)
  registerBanner(pi, settings)
  registerStatusLine(pi)
  registerPromptEditor(pi)

  registerThinking(pi, thinking)

  registerCommands(pi, settings, groups)
}
