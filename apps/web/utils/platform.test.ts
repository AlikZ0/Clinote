import { describe, expect, it } from 'vitest'
import { assessStorageRisk, detectPlatform, installInstructions } from './platform'

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
const IPAD_DESKTOP_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
const ANDROID =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36'
const DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

describe('detectPlatform', () => {
  it('recognises the platforms that behave differently', () => {
    expect(detectPlatform(IPHONE)).toBe('ios')
    expect(detectPlatform(ANDROID)).toBe('android')
    expect(detectPlatform(DESKTOP)).toBe('desktop')
    expect(detectPlatform('')).toBe('unknown')
  })

  it('sees through iPadOS pretending to be a Mac', () => {
    expect(detectPlatform(IPAD_DESKTOP_UA, 5)).toBe('ios')
    expect(detectPlatform(IPAD_DESKTOP_UA, 0)).toBe('desktop')
  })
})

describe('assessStorageRisk', () => {
  it('treats an uninstalled iOS browser as critical, persistence or not', () => {
    for (const persisted of [true, false]) {
      const advice = assessStorageRisk({ platform: 'ios', standalone: false, persisted })
      expect(advice.risk).toBe('critical')
      expect(advice.action).toBe('install')
      expect(advice.messageKey).toBe('storage.installBody')
    }
  })

  it('reports protection once the browser granted it', () => {
    const advice = assessStorageRisk({ platform: 'desktop', standalone: false, persisted: true })
    expect(advice.risk).toBe('protected')
    expect(advice.action).toBe('none')
  })

  it('asks for persistence where the API actually grants it', () => {
    for (const platform of ['android', 'desktop'] as const) {
      const advice = assessStorageRisk({ platform, standalone: false, persisted: false })
      expect(advice.risk).toBe('at_risk')
      expect(advice.action).toBe('persist')
    }
  })

  it('advises exports on installed iOS rather than promising a guarantee', () => {
    const advice = assessStorageRisk({ platform: 'ios', standalone: true, persisted: false })
    expect(advice.risk).toBe('at_risk')
    // Advice to export, not a promise of safety.
    expect(advice.action).toBe('export')
    expect(advice.messageKey).toBe('storage.exportBody')
  })
})

describe('installInstructions', () => {
  it('explains the manual install where no prompt API exists', () => {
    expect(installInstructions('ios')).toMatch(/Add to Home Screen/)
    expect(installInstructions('android')).toMatch(/Install app/)
    expect(installInstructions('desktop')).toBeNull()
  })
})
