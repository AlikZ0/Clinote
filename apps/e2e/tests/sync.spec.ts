/**
 * Two devices, one account (docs/sync.md).
 *
 * The unit tests prove the sync engine merges correctly. What only a browser
 * can show is that a real second device, holding only the passphrase, ends up
 * with the same records — through the whole chain of key derivation, envelope
 * encryption, transport and merge.
 */
import { expect, test } from '@playwright/test'
import {
  addClient,
  newAccount,
  register,
  setUpEncryption,
  signIn,
  syncNow,
  unlock,
  upgrade,
} from '../support/app'

const PASSPHRASE = 'a passphrase for two devices'

test('a record written on one device appears on another', async ({ browser }) => {
  const account = newAccount('sync')

  const first = await browser.newContext()
  const deviceA = await first.newPage()
  await register(deviceA, account)
  await upgrade(deviceA, 'Pro')
  await setUpEncryption(deviceA, PASSPHRASE)
  await addClient(deviceA, { firstName: 'Mariam', lastName: 'Sargsyan' })
  await syncNow(deviceA)

  // A different browser context is a different device: its own IndexedDB, its
  // own device id, no shared memory with the first.
  const second = await browser.newContext()
  const deviceB = await second.newPage()
  await signIn(deviceB, account)
  await unlock(deviceB, PASSPHRASE)
  await syncNow(deviceB)

  await deviceB.goto('/clients')
  await expect(deviceB.getByText('Sargsyan Mariam')).toBeVisible()

  await first.close()
  await second.close()
})

test('a device that cannot unlock still works on its own data', async ({ browser }) => {
  const account = newAccount('locked')

  const first = await browser.newContext()
  const deviceA = await first.newPage()
  await register(deviceA, account)
  await upgrade(deviceA, 'Pro')
  await setUpEncryption(deviceA, PASSPHRASE)

  const second = await browser.newContext()
  const deviceB = await second.newPage()
  await signIn(deviceB, account)

  // No passphrase entered here. "Locked" is a state, not an error: the device
  // says what is missing and everything local keeps working.
  await deviceB.goto('/settings')
  await expect(deviceB.getByText('Unlock this device to sync and back up')).toBeVisible()

  await addClient(deviceB, { firstName: 'Local', lastName: 'Only' })
  await deviceB.goto('/clients')
  await expect(deviceB.getByText('Only Local')).toBeVisible()

  await first.close()
  await second.close()
})
