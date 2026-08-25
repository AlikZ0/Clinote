/**
 * What a Free account sees (product spec §56, invariant I2).
 *
 * A locked feature has to explain itself. And nothing that is already on the
 * device may stop working because of a plan.
 */
import { expect, test } from '@playwright/test'
import { addClient, newAccount, register } from '../support/app'

test('a locked feature explains itself instead of disappearing', async ({ page }) => {
  await page.goto('/calendar')

  await expect(page.getByText('Available with Clinote Pro')).toBeVisible()
  await expect(page.getByRole('link', { name: 'See plans' })).toBeVisible()
})

test('local data keeps working while a paid feature is locked', async ({ page }) => {
  await register(page, newAccount('free'))
  await addClient(page, { firstName: 'Mariam', lastName: 'Sargsyan' })

  await page.goto('/calendar')
  await expect(page.getByText('Available with Clinote Pro')).toBeVisible()

  // The point of I2: the lock is on the feature, never on the records.
  await page.goto('/clients')
  await expect(page.getByText('Sargsyan Mariam')).toBeVisible()
})
