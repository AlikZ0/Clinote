/**
 * Backup and restore, through the browser (docs/backup.md).
 *
 * The unit tests cover the archive format and the API covers the upload
 * protocol. What is only true end to end is that a device which has lost
 * everything can get it back — encryption, upload, download, decryption and
 * the atomic swap, in one go.
 */
import { expect, test } from '@playwright/test'
import { addClient, cardFor, newAccount, register, setUpEncryption, upgrade } from '../support/app'

const PASSPHRASE = 'a passphrase for backups'

/**
 * Cloud backup needs somewhere to upload to.
 *
 * The device PUTs the archive straight to object storage, so a stand-in that
 * hands out unusable URLs would test nothing. `pnpm db:up` provides MinIO, and
 * so does CI; without it this one test steps aside and says why.
 */
test.skip(
  !process.env.E2E_S3_ENDPOINT,
  'set E2E_S3_ENDPOINT (pnpm db:up provides one) to exercise cloud backup',
)

test('a wiped device gets its records back from a cloud backup', async ({ page }) => {
  await register(page, newAccount('backup'))
  await upgrade(page, 'Pro')
  await setUpEncryption(page, PASSPHRASE)
  await addClient(page, { firstName: 'Mariam', lastName: 'Sargsyan' })

  await page.goto('/backup')
  const cloud = cardFor(page, 'Cloud Backup')
  await cloud.getByRole('button', { name: 'Back up now' }).click()
  await expect(cloud.getByRole('button', { name: 'Restore' })).toBeVisible({ timeout: 30_000 })

  // The device loses everything: this is a new phone, or a cleared browser.
  await page.evaluate(async () => {
    for (const database of await indexedDB.databases()) {
      if (database.name) indexedDB.deleteDatabase(database.name)
    }
  })
  await page.reload()
  await page.goto('/clients')
  await expect(page.getByText('No clients yet')).toBeVisible()

  await setUpEncryptionOrUnlock(page)

  await page.goto('/backup')
  await cloud.getByRole('button', { name: 'Restore' }).first().click()
  await cloud.getByRole('button', { name: 'Yes, restore' }).click()

  await page.goto('/clients')
  await expect(page.getByText('Sargsyan Mariam')).toBeVisible({ timeout: 30_000 })
})

/**
 * After a wipe the device has no stored key, so it has to unlock again — the
 * passphrase is the only thing that survived, which is the design.
 */
async function setUpEncryptionOrUnlock(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/settings')
  const card = cardFor(page, 'Encryption')
  await card.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE)
  await card.getByRole('button', { name: 'Unlock', exact: true }).click()
  await expect(card.getByText('This device is unlocked')).toBeVisible()
}

test('the local export names the file and says what it contains', async ({ page }) => {
  await register(page, newAccount('export'))
  await addClient(page, { firstName: 'Anahit', lastName: 'Grigoryan' })

  await page.goto('/backup')
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export my data' }).click()

  // A Free account's way out: one file, on their own disk, no account needed.
  // The archive is a zip, and is named like one (docs/backup.md §2).
  expect((await download).suggestedFilename()).toMatch(/^clinote-backup-\d{4}-\d{2}-\d{2}\.zip$/)
})
