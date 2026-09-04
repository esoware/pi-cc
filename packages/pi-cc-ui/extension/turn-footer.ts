import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'

import { formatDuration } from './format.js'
import { HOST_HARDCODED_PAD } from './host-patches.js'

const TURN_FOOTER_ENTRY = 'cc-turn-footer'
const TURN_VERB = 'Worked'
const MIN_REPORTED_TURN_MS = 1000

interface TurnFooterData {
  readonly ms: number
}

export function registerTurnFooter(pi: ExtensionAPI): void {
  let runStartedAt: number | undefined = undefined

  function forgetRun(): void {
    runStartedAt = undefined
  }

  pi.on('session_start', forgetRun)
  pi.on('session_shutdown', forgetRun)

  pi.on('agent_start', () => {
    runStartedAt ??= Date.now()
  })

  pi.on('agent_settled', () => {
    if (runStartedAt === undefined) {
      return
    }
    const durationMs = Date.now() - runStartedAt
    runStartedAt = undefined
    if (durationMs >= MIN_REPORTED_TURN_MS) {
      pi.appendEntry<TurnFooterData>(TURN_FOOTER_ENTRY, { ms: durationMs })
    }
  })

  pi.registerEntryRenderer<TurnFooterData>(TURN_FOOTER_ENTRY, (entry, _options, theme) => {
    const durationMs = entry.data?.ms ?? 0
    return new Text(
      theme.fg('dim', `✻ ${TURN_VERB} for ${formatDuration(durationMs)}`),
      HOST_HARDCODED_PAD,
      0,
    )
  })
}
