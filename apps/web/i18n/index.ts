/**
 * Locales.
 *
 * Three catalogues, one shape. English is the source; the others are typed
 * against it, so a missing key is a type error rather than a raw key on screen.
 */
import { en, type Messages } from './en'
import { ru } from './ru'
import { hy } from './hy'

export const LOCALES = ['en', 'ru', 'hy'] as const
export type Locale = (typeof LOCALES)[number]

export const MESSAGES: Record<Locale, Messages> = { en, ru, hy }

export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  ru: 'Русский',
  hy: 'Հայերեն',
}

/** BCP-47 tags used for dates and numbers. */
export const LOCALE_TAGS: Record<Locale, string> = {
  en: 'en-GB',
  ru: 'ru-RU',
  hy: 'hy-AM',
}

export type { Messages } from './en'

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/** Picks the closest supported locale from what the browser asks for. */
export function detectLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.toLowerCase().split('-')[0]
    if (isLocale(base)) return base
  }
  return 'en'
}
