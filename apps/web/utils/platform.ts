/**
 * Platform detection and the storage-risk advice derived from it.
 *
 * These are pure functions on purpose: the rules behind them are the R1
 * mitigation (docs/architecture.md §7), and rules that protect the system of
 * record must be testable without a browser.
 */
export type Platform = 'ios' | 'android' | 'desktop' | 'unknown'

export function detectPlatform(userAgent: string, maxTouchPoints = 0): Platform {
  const ua = userAgent.toLowerCase()

  // iPadOS reports itself as a Macintosh; touch points are what separates them.
  if (/iphone|ipad|ipod/.test(ua) || (/macintosh/.test(ua) && maxTouchPoints > 1)) return 'ios'
  if (/android/.test(ua)) return 'android'
  if (/windows|macintosh|linux|cros/.test(ua)) return 'desktop'
  return 'unknown'
}

export type StorageRisk = 'protected' | 'at_risk' | 'critical'
export type StorageAction = 'install' | 'persist' | 'export' | 'none'

export interface StorageAdvice {
  risk: StorageRisk
  /** Message keys, so the wording lives in the catalogues, not here. */
  titleKey: string
  messageKey: string
  action: StorageAction
}

export interface StorageContext {
  platform: Platform
  /** Running as an installed app rather than a browser tab. */
  standalone: boolean
  /** The browser promised not to evict this origin. */
  persisted: boolean
}

/**
 * What the user must be told about the durability of their data.
 *
 * The critical case is real and specific: Safari clears storage for a site that
 * is not on the Home Screen after roughly seven days without a visit. For a
 * Free user that is the loss of the system of record, so it is stated plainly
 * rather than softened.
 */
export function assessStorageRisk(context: StorageContext): StorageAdvice {
  if (context.platform === 'ios' && !context.standalone) {
    return {
      risk: 'critical',
      titleKey: 'storage.installTitle',
      messageKey: 'storage.installBody',
      action: 'install',
    }
  }

  if (context.persisted) {
    return {
      risk: 'protected',
      titleKey: 'storage.protectedTitle',
      messageKey: 'storage.protectedBody',
      action: 'none',
    }
  }

  if (context.platform === 'ios') {
    // Installed iOS apps are not subject to the seven-day rule, but iOS does
    // not grant an explicit persistence guarantee either. Regular exports are
    // the honest advice.
    return {
      risk: 'at_risk',
      titleKey: 'storage.exportTitle',
      messageKey: 'storage.exportBody',
      action: 'export',
    }
  }

  return {
    risk: 'at_risk',
    titleKey: 'storage.persistTitle',
    messageKey: 'storage.persistBody',
    action: 'persist',
  }
}

/** Instructions for the platforms that have no install prompt API. */
export function installInstructions(platform: Platform): string | null {
  switch (platform) {
    case 'ios':
      return 'Open the Share menu and choose "Add to Home Screen".'
    case 'android':
      return 'Open the browser menu and choose "Install app" or "Add to Home screen".'
    default:
      return null
  }
}
