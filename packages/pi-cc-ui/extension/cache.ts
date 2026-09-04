export class KeyedCache<TValue> {
  private entry: { key: string; value: TValue } | undefined = undefined

  get(key: string, build: () => TValue): TValue {
    const entry = this.entry
    if (entry?.key === key) {
      return entry.value
    }
    const value = build()
    this.entry = { key, value }
    return value
  }

  clear(): void {
    this.entry = undefined
  }
}

const CACHE_KEY_SEPARATOR = String.fromCodePoint(0)

export function cacheKey(...parts: readonly (string | number | boolean)[]): string {
  return parts.map(String).join(CACHE_KEY_SEPARATOR)
}
