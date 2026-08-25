/**
 * Translation.
 *
 * Small on purpose: an SPA with no localized routing needs a catalogue, a
 * chosen locale and interpolation — not a routing framework.
 *
 * The choice is stored in the local settings table rather than in localStorage,
 * for the same reason everything else is (docs/local-first.md §9).
 */
import { getLocalCore } from '~/database'
import { detectLocale, isLocale, LOCALE_TAGS, MESSAGES, type Locale, type Messages } from '~/i18n'

const LOCALE_SETTING = 'app.locale'

/** Dotted paths into the catalogue, e.g. `clients.newClient`. */
type Path<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Path<T[K], `${Prefix}${K}.`>
}[keyof T & string]

export type MessageKey = Path<Messages>

export function useI18n() {
  const locale = useState<Locale>('i18n.locale', () => 'en')
  const ready = useState('i18n.ready', () => false)

  /**
   * Looks a message up, falling back to English and then to the key itself —
   * a missing translation must never render as an empty element.
   */
  function t(key: MessageKey, params?: Record<string, string | number>): string {
    const message = lookup(MESSAGES[locale.value], key) ?? lookup(MESSAGES.en, key) ?? key
    if (!params) return message

    return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
      name in params ? String(params[name]) : whole,
    )
  }

  async function setLocale(next: Locale): Promise<void> {
    locale.value = next
    if (typeof document !== 'undefined') document.documentElement.lang = next

    try {
      const core = await getLocalCore()
      await core.settings.set(LOCALE_SETTING, next)
    } catch {
      // The app is still translated; only the memory of the choice is lost.
    }
  }

  /** Restores the stored choice, or takes the browser's word for it. */
  async function restoreLocale(): Promise<void> {
    let chosen: Locale | null = null
    try {
      const core = await getLocalCore()
      const stored = await core.settings.get<string | null>(LOCALE_SETTING, null)
      if (isLocale(stored)) chosen = stored
    } catch {
      chosen = null
    }

    locale.value =
      chosen ?? (typeof navigator === 'undefined' ? 'en' : detectLocale(navigator.languages ?? []))
    if (typeof document !== 'undefined') document.documentElement.lang = locale.value
    ready.value = true
  }

  return {
    locale,
    ready,
    t,
    setLocale,
    restoreLocale,
    /** For `Intl` formatting, which wants a BCP-47 tag. */
    tag: computed(() => LOCALE_TAGS[locale.value]),
  }
}

function lookup(messages: Messages, key: string): string | null {
  const value = key
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], messages)
  return typeof value === 'string' ? value : null
}
