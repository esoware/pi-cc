const MS_PER_SECOND = 1000
const SECONDS_PER_MINUTE = 60
const SECONDS_PER_HOUR = 3600

const TOKENS_PER_K = 1000
const TOKENS_DECIMAL_LIMIT = 10_000
const TRAILING_ZERO_DECIMAL_RE = /\.0$/u

const WHITESPACE_RUN_RE = /\s+/gu

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / MS_PER_SECOND))
  const hours = Math.floor(totalSeconds / SECONDS_PER_HOUR)
  const minutes = Math.floor((totalSeconds % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE)
  const seconds = totalSeconds % SECONDS_PER_MINUTE
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`
  }
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

export function formatTokenCount(count: number): string {
  if (count < TOKENS_PER_K) {
    return String(count)
  }
  if (count < TOKENS_DECIMAL_LIMIT) {
    return `${(count / TOKENS_PER_K).toFixed(1).replace(TRAILING_ZERO_DECIMAL_RE, '')}k`
  }
  return `${Math.round(count / TOKENS_PER_K)}k`
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural
}

export function collapseWhitespace(text: string): string {
  return text.replaceAll(WHITESPACE_RUN_RE, ' ').trim()
}

export function truncateChars(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text
}
