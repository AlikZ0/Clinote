import { describe, expect, it } from 'vitest'
import { detectLocale, isLocale, LOCALES, LOCALE_NAMES, LOCALE_TAGS, MESSAGES } from './index'

/** Every leaf path in a catalogue, so two catalogues can be compared exactly. */
function paths(value: unknown, prefix = ''): string[] {
  if (typeof value === 'string') return [prefix]
  if (typeof value !== 'object' || value === null) return []

  return Object.entries(value).flatMap(([key, child]) =>
    paths(child, prefix ? `${prefix}.${key}` : key),
  )
}

describe('catalogues', () => {
  const english = paths(MESSAGES.en).sort()

  it.each(LOCALES)('%s has exactly the keys English has', (locale) => {
    expect(paths(MESSAGES[locale]).sort()).toEqual(english)
  })

  it.each(LOCALES)('%s leaves nothing empty', (locale) => {
    for (const key of paths(MESSAGES[locale])) {
      const value = key
        .split('.')
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], MESSAGES[locale])
      expect(String(value).trim().length, `${locale}.${key}`).toBeGreaterThan(0)
    }
  })

  it.each(LOCALES)('%s keeps the placeholders English uses', (locale) => {
    for (const key of english) {
      const read = (source: unknown) =>
        String(
          key
            .split('.')
            .reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], source),
        )
      const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort()

      // A translation that drops {count} renders a sentence with a hole in it.
      expect(placeholders(read(MESSAGES[locale])), `${locale}.${key}`).toEqual(
        placeholders(read(MESSAGES.en)),
      )
    }
  })

  it('is actually translated, not copied', () => {
    // A handful of anchors: if these match English, the catalogue is a stub.
    expect(MESSAGES.ru.nav.clients).not.toBe(MESSAGES.en.nav.clients)
    expect(MESSAGES.hy.nav.clients).not.toBe(MESSAGES.en.nav.clients)
    expect(MESSAGES.ru.nav.clients).not.toBe(MESSAGES.hy.nav.clients)
  })

  it('names and tags every locale', () => {
    for (const locale of LOCALES) {
      expect(LOCALE_NAMES[locale]).toBeTruthy()
      expect(LOCALE_TAGS[locale]).toMatch(/^[a-z]{2}-[A-Z]{2}$/)
    }
  })
})

describe('detection', () => {
  it('takes the first supported language the browser asks for', () => {
    expect(detectLocale(['hy-AM', 'ru-RU', 'en-US'])).toBe('hy')
    expect(detectLocale(['ru'])).toBe('ru')
    expect(detectLocale(['en-GB'])).toBe('en')
  })

  it('skips languages it does not have', () => {
    expect(detectLocale(['fr-FR', 'de-DE', 'ru-RU'])).toBe('ru')
  })

  it('falls back to English rather than to nothing', () => {
    expect(detectLocale([])).toBe('en')
    expect(detectLocale(['zh-CN'])).toBe('en')
  })

  it('recognises only the locales that exist', () => {
    expect(isLocale('ru')).toBe(true)
    expect(isLocale('fr')).toBe(false)
  })
})
