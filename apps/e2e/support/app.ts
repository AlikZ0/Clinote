/**
 * Driving Clinote from the outside.
 *
 * Selectors go through roles and labels rather than CSS classes: they are what
 * a person and a screen reader both use, so a test that cannot find a control
 * is telling us something real about the interface.
 */
import { expect, type Page } from '@playwright/test'

/**
 * The card whose *heading* is this, not the first card that happens to mention
 * it — the Account card explains what Cloud Sync is, and matching on prose
 * picked that one up.
 */
export function cardFor(page: Page, heading: string) {
  return page.locator('.card').filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
}

export interface Account {
  email: string
  password: string
}

let counter = 0

/** A fresh address per test, so parallel workers never share an account. */
export function newAccount(prefix: string): Account {
  counter += 1
  return {
    email: `${prefix}-${process.pid}-${counter}@clinote.test`,
    password: 'correct horse battery staple',
  }
}

export async function register(page: Page, account: Account): Promise<void> {
  await page.goto('/auth/register')
  await page.getByLabel('Email').fill(account.email)
  await page.getByLabel('Password').fill(account.password)
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByText(account.email)).toBeVisible()
}

export async function signIn(page: Page, account: Account): Promise<void> {
  await page.goto('/auth/login')
  await page.getByLabel('Email').fill(account.email)
  await page.getByLabel('Password').fill(account.password)
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page.getByText(account.email)).toBeVisible()
}

/** Walks the real checkout, including the development confirmation page. */
export async function upgrade(page: Page, plan: 'Pro' | 'Business'): Promise<void> {
  await page.goto('/settings')
  const row = page.locator('.list-item', { hasText: `Clinote ${plan}` })
  await row.getByRole('button', { name: 'Upgrade' }).click()

  await page.waitForURL(/\/billing\/checkout/)
  await page.getByRole('button', { name: 'Complete this purchase' }).click()
  await expect(page.getByText('Your plan has been updated')).toBeVisible()
}

export async function setUpEncryption(page: Page, passphrase: string): Promise<void> {
  await page.goto('/settings')
  const card = cardFor(page, 'Encryption')

  // The card only offers a passphrase once the account has something to
  // encrypt for — a Free account is shown what Pro does instead.
  await expect(
    card.getByText('Choose an encryption passphrase'),
    'the encryption card is not offering setup: is this account on Pro?',
  ).toBeVisible()

  await card.getByLabel('Passphrase', { exact: true }).fill(passphrase)
  await card.getByLabel('Repeat passphrase').fill(passphrase)
  await card.getByRole('checkbox').check()
  await card.getByRole('button', { name: /Turn on encryption|Protect my data/ }).click()

  // The recovery key is shown once and has to be acknowledged.
  await card.getByRole('button', { name: 'I have saved it' }).click()
  await expect(card.getByText('This device is unlocked')).toBeVisible()
}

export async function unlock(page: Page, passphrase: string): Promise<void> {
  await page.goto('/settings')
  const card = cardFor(page, 'Encryption')
  await card.getByLabel('Passphrase', { exact: true }).fill(passphrase)
  await card.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(card.getByText('This device is unlocked')).toBeVisible()
}

export async function addClient(
  page: Page,
  client: { firstName: string; lastName: string; notes?: string },
): Promise<void> {
  await page.goto('/clients/new')
  await page.getByLabel('First name').fill(client.firstName)
  await page.getByLabel('Last name').fill(client.lastName)
  await page.getByLabel('Arrival date').fill('2026-08-25')
  if (client.notes) await page.getByLabel(/Notes/).fill(client.notes)
  await page.getByRole('button', { name: 'Save', exact: true }).click()

  await expect(page.getByRole('heading', { name: `${client.lastName} ${client.firstName}` })).toBeVisible()
}

/**
 * Pushes and pulls now, instead of waiting for the fifteen-second tick.
 *
 * Retried because a sync can legitimately have nothing to do yet: the outbox is
 * written in the same transaction as the record, but the engine may already
 * have been mid-cycle when it landed.
 */
export async function syncNow(page: Page, who = 'device'): Promise<void> {
  await page.goto('/settings')
  const card = cardFor(page, 'Cloud Sync')

  try {
    await expect(async () => {
      await card.getByRole('button', { name: 'Sync now' }).click()
      await expect(card.getByText('Queued changes')).toBeVisible()
      await expect(card.locator('dd.value').first()).toHaveText('0')
    }).toPass({ timeout: 30_000 })
  } catch (error) {
    // Which device, and what the card actually said — otherwise a failure here
    // is a timeout with no story attached.
    const state = await card.innerText().catch(() => '<no sync card>')
    throw new Error(`sync never settled for ${who}: ${state.replace(/\n+/g, ' | ')}`, {
      cause: error,
    })
  }
}

/**
 * Waits until the service worker is actually in charge of this page.
 *
 * Registration is not control: on a first visit the worker installs but does
 * not claim the page that registered it, which is the browser's default and
 * ours. One reload later it serves navigations, and only then does "open the
 * app with no network" mean anything.
 */
export async function waitForServiceWorker(page: Page): Promise<void> {
  await expect(async () => {
    const activated = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      // `active` is set while the worker is still activating; only the state
      // says whether it is ready to serve a navigation.
      return registration?.active?.state === 'activated'
    })
    expect(activated).toBe(true)

    await page.reload()
    expect(await page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  }).toPass({ timeout: 45_000 })
}

/**
 * Opens the workspace menu and switches datasets.
 *
 * Switching closes one local database and opens another, and the app reloads to
 * make sure no screen is still holding rows from the one it left — so this
 * waits for that reload rather than racing it.
 */
async function openWorkspaceMenu(page: Page): Promise<void> {
  const menu = page.locator('.switcher__menu')
  // Clicking a button that is already showing its menu would close it again.
  if (!(await menu.isVisible())) await page.locator('.switcher__button').click()
  await expect(menu).toBeVisible()
}

export async function switchWorkspace(page: Page, name: string): Promise<void> {
  // Opening a menu and clicking an item is two interactions with a re-render
  // between them, so the pair is retried rather than each half separately.
  await expect(async () => {
    await openWorkspaceMenu(page)
    await page.locator('.switcher__item', { hasText: name }).first().click({ timeout: 5_000 })
  }).toPass({ timeout: 30_000 })

  // Switching starts the page over, on the dashboard.
  await page.waitForURL((url) => url.pathname === '/')
  await expect(page.locator('.switcher__name')).toHaveText(name)
}

/** The datasets this device can currently choose between. */
export async function workspaceChoices(page: Page): Promise<string[]> {
  await openWorkspaceMenu(page)
  const items = await page.locator('.switcher__item').allInnerTexts()
  // Left closed, so the next interaction starts from a known state.
  await page.locator('.switcher__button').click()
  await expect(page.locator('.switcher__menu')).toBeHidden()
  return items.map((item) => item.replace(/[\s✓]+$/, '').trim())
}

/** What the app is, with no server at all: everything the Free plan promises. */
export async function goOffline(page: Page): Promise<void> {
  await page.context().setOffline(true)
}

export async function goOnline(page: Page): Promise<void> {
  await page.context().setOffline(false)
}
