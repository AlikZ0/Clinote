/**
 * A practice with two people (product spec §41–§44).
 *
 * The whole chain in one test, because every link is only meaningful with the
 * others: invite, join, be granted the workspace key by a colleague's device,
 * and only then read what they wrote.
 */
import { expect, test, type Page } from '@playwright/test'
import {
  addClient,
  cardFor,
  newAccount,
  register,
  setUpEncryption,
  switchWorkspace,
  syncNow,
  upgrade,
  workspaceChoices,
} from '../support/app'

const OWNER_PASSPHRASE = 'the clinic passphrase'
const COLLEAGUE_PASSPHRASE = 'a different long passphrase'

async function createWorkspace(page: Page, name: string): Promise<void> {
  await page.goto('/team')
  await cardFor(page, 'Create a workspace').getByLabel('Workspace name').fill(name)
  await cardFor(page, 'Create a workspace').getByRole('button', { name: 'Create workspace' }).click()
  // Creating it also opens it: the switcher is showing the new dataset.
  await expect(page.locator('.switcher__name')).toHaveText(name)
}

async function invite(page: Page, email: string, role: string): Promise<string> {
  const card = cardFor(page, 'Invite someone')
  await card.getByLabel('Email').fill(email)
  await card.getByLabel('Role').selectOption({ label: role })
  await card.getByRole('button', { name: 'Send invitation' }).click()

  // Outside production the code is shown instead of emailed, which is what
  // makes this walkable without a mailbox.
  const shown = await card.locator('code').innerText()
  expect(shown.length).toBeGreaterThan(20)
  return shown
}

test('a colleague joins, is granted access, and reads the clinic’s records', async ({ browser }) => {
  const owner = newAccount('owner')
  const colleague = newAccount('colleague')

  const ownerContext = await browser.newContext()
  const ownerPage = await ownerContext.newPage()
  await register(ownerPage, owner)
  await upgrade(ownerPage, 'Business')
  await setUpEncryption(ownerPage, OWNER_PASSPHRASE)
  await createWorkspace(ownerPage, 'Yerevan Clinic')

  // Written inside the workspace, so it belongs to the practice.
  await addClient(ownerPage, { firstName: 'Mariam', lastName: 'Sargsyan' })
  await syncNow(ownerPage, 'owner')

  await ownerPage.goto('/team')
  const token = await invite(ownerPage, colleague.email, 'Doctor')

  const colleagueContext = await browser.newContext()
  const colleaguePage = await colleagueContext.newPage()
  await register(colleaguePage, colleague)

  // No subscription of their own: the clinic that invited them pays.
  await colleaguePage.goto('/team')
  const join = cardFor(colleaguePage, 'Join a workspace')
  await join.getByLabel('Invitation code').fill(token)
  await join.getByRole('button', { name: 'Join', exact: true }).click()

  // Joining adds the workspace to the list; it does not move the colleague
  // into it, and it does not give them anything to read yet.
  expect(await workspaceChoices(colleaguePage)).toContain('Yerevan Clinic')

  await setUpEncryption(colleaguePage, COLLEAGUE_PASSPHRASE)
  await switchWorkspace(colleaguePage, 'Yerevan Clinic')

  await colleaguePage.goto('/team')
  await expect(colleaguePage.getByText('nobody has given you its key yet')).toBeVisible()

  // The owner's device is the only place the key exists.
  await ownerPage.goto('/team')
  const waiting = cardFor(ownerPage, 'Waiting for access')
  await expect(waiting.getByText(colleague.email)).toBeVisible()
  await waiting.getByRole('button', { name: 'Give access' }).click()

  await colleaguePage.reload()
  await syncNow(colleaguePage, 'colleague')
  await colleaguePage.goto('/clients')
  await expect(colleaguePage.getByText('Sargsyan Mariam')).toBeVisible({ timeout: 30_000 })

  await ownerContext.close()
  await colleagueContext.close()
})

test('personal records and workspace records stay apart', async ({ page }) => {
  await register(page, newAccount('switch'))
  await upgrade(page, 'Business')
  await setUpEncryption(page, OWNER_PASSPHRASE)

  await addClient(page, { firstName: 'Personal', lastName: 'Record' })
  await createWorkspace(page, 'Second Branch')
  await addClient(page, { firstName: 'Clinic', lastName: 'Record' })

  await page.goto('/clients')
  await expect(page.getByText('Record Clinic')).toBeVisible()
  await expect(page.getByText('Record Personal')).toBeHidden()

  // Switching back is a different local database, not a filter.
  await switchWorkspace(page, 'Personal')

  await page.goto('/clients')
  await expect(page.getByText('Record Personal')).toBeVisible()
  await expect(page.getByText('Record Clinic')).toBeHidden()
})
