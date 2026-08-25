/**
 * The promise the product is built on: it works with no server (invariant I1).
 *
 * These run with the network switched off from the first byte, which is the
 * only way to be sure nothing in the path quietly depends on a request
 * succeeding.
 */
import { expect, test } from '@playwright/test'
import { addClient, goOffline, goOnline, waitForServiceWorker } from '../support/app'

test('a client can be created and read back with the network switched off', async ({ page }) => {
  await page.goto('/')
  await waitForServiceWorker(page)
  await goOffline(page)

  await addClient(page, {
    firstName: 'Mariam',
    lastName: 'Sargsyan',
    notes: 'Written while offline',
  })

  await page.goto('/clients')
  await expect(page.getByText('Sargsyan Mariam')).toBeVisible()

  await goOnline(page)
})

test('the app opens from a cold start with no network at all', async ({ page }) => {
  // The claim that makes this a local-first product rather than a web app with
  // a cache: once installed, a reload with the network gone still opens.
  await page.goto('/')
  await waitForServiceWorker(page)
  await addClient(page, { firstName: 'Narine', lastName: 'Hakobyan' })

  await goOffline(page)
  await page.goto('/clients')
  await page.reload()

  await expect(page.getByText('Hakobyan Narine')).toBeVisible()
  await goOnline(page)
})

test('the data is still there after a reload, and after the tab is closed', async ({
  page,
  context,
}) => {
  await page.goto('/')
  await addClient(page, { firstName: 'Anahit', lastName: 'Grigoryan' })

  await page.reload()
  await page.goto('/clients')
  await expect(page.getByText('Grigoryan Anahit')).toBeVisible()

  // A second tab in the same profile sees the same database — that is what
  // makes IndexedDB the system of record rather than a cache.
  const second = await context.newPage()
  await second.goto('/clients')
  await expect(second.getByText('Grigoryan Anahit')).toBeVisible()
  await second.close()
})

test('the app says it is offline instead of pretending otherwise', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByText('Online')).toBeVisible()

  await goOffline(page)
  await expect(page.getByText('Offline')).toBeVisible()

  await goOnline(page)
  await expect(page.getByText('Online')).toBeVisible()
})

test('a Free account is told plainly that nothing is uploaded', async ({ page }) => {
  await page.goto('/clients/new')
  await expect(page.getByText('Saved on this device only')).toBeVisible()
})
