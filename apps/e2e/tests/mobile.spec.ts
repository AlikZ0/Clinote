/**
 * The mobile matrix (product spec §80).
 *
 * Runs in the phone projects only. What it can check is layout, reach and the
 * core flow at a real phone's viewport; what it cannot check is Safari, and
 * `docs/testing.md` says so rather than letting a green run imply otherwise.
 */
import { expect, test } from '@playwright/test'
import { addClient, newAccount, register } from '../support/app'

test.skip(({ isMobile }) => !isMobile, 'phone projects only')

test('the navigation sits at the bottom, where a thumb reaches', async ({ page }) => {
  await page.goto('/')

  const nav = page.locator('nav.nav').last()
  await expect(nav).toBeVisible()

  const viewport = page.viewportSize()!
  const box = (await nav.boundingBox())!
  // Bottom half of the screen, not a menu at the top of a tall phone.
  expect(box.y).toBeGreaterThan(viewport.height / 2)
})

test('every control is big enough to hit', async ({ page }) => {
  await page.goto('/clients/new')

  // 44px is the smallest target that can be tapped reliably (§80).
  for (const control of await page.getByRole('button').all()) {
    if (!(await control.isVisible())) continue
    const box = await control.boundingBox()
    expect(
      box!.height,
      `"${(await control.innerText()).trim()}" is too short to tap`,
    ).toBeGreaterThanOrEqual(44)
  }
})

test('nothing spills sideways', async ({ page }) => {
  await register(page, newAccount('mobile'))
  await addClient(page, { firstName: 'Mariam', lastName: 'Sargsyan', notes: 'A'.repeat(400) })

  for (const path of ['/', '/clients', '/settings', '/backup']) {
    await page.goto(path)
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    // A phone screen that scrolls sideways is a broken one.
    expect(overflow, `${path} scrolls horizontally`).toBeLessThanOrEqual(1)
  }
})

test('the everyday flow works on a phone', async ({ page }) => {
  await register(page, newAccount('phone'))

  await page.getByRole('link', { name: 'Clients' }).last().click()
  await page.getByRole('link', { name: 'New client' }).click()
  await page.getByLabel('First name').fill('Anahit')
  await page.getByLabel('Last name').fill('Grigoryan')
  await page.getByLabel('Arrival date').fill('2026-08-26')
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(page.getByRole('heading', { name: 'Grigoryan Anahit' })).toBeVisible()
})
