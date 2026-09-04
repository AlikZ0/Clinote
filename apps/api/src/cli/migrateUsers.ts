#!/usr/bin/env node

/**
 * CLI: Migrate users to organizations
 *
 * Usage:
 *   pnpm migrate:users --dry-run     # Preview migration
 *   pnpm migrate:users --confirm     # Run migration
 *   pnpm migrate:users --verify      # Check migration status
 *
 * Phase 19: Converts single-tenant (user) to multi-tenant (org) model.
 */

/* eslint-disable no-console -- a CLI reports to stdout; that is its interface. */

import { createStorage } from '../storage'
import { migrateUsersToOrganizations, verifyMigration } from '../migrations/userToOrganization'
import { loadEnv } from '../env'

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const verify = args.includes('--verify')
  const confirm = args.includes('--confirm') && !dryRun

  if (!dryRun && !verify && !confirm) {
    console.log(`
Migration: Users → Organizations (Phase 19)

Usage:
  pnpm migrate:users --dry-run       Run migration simulation
  pnpm migrate:users --confirm       Run actual migration
  pnpm migrate:users --verify        Check migration status

Options:
  --dry-run     Simulate migration without writing to database
  --confirm     Commit changes to database
  --verify      Check that all users have organizations

Environment:
  DATABASE_URL  PostgreSQL connection string (required)
    `)
    process.exit(0)
  }

  const env = loadEnv()
  const storage = await createStorage(env)
  const { stores } = storage

  try {
    if (verify) {
      console.log('📊 Verifying migration status...\n')
      const result = await verifyMigration(stores)

      console.log(`✅ Users with organization: ${result.usersWithOrg}`)
      if (result.usersWithoutOrg.length > 0) {
        console.log(`⚠️  Users WITHOUT organization: ${result.usersWithoutOrg.length}`)
        if (result.usersWithoutOrg.length <= 10) {
          console.log(`   IDs: ${result.usersWithoutOrg.join(', ')}`)
        }
      }
      console.log(`❌ Workspaces without organization: ${result.workspacesWithoutOrg}`)

      if (result.usersWithoutOrg.length === 0 && result.workspacesWithoutOrg === 0) {
        console.log('\n🎉 Migration appears complete!')
      } else {
        console.log('\n⚠️  Migration incomplete or issues found.')
      }
      return
    }

    if (dryRun) {
      console.log('🧪 Running migration in DRY-RUN mode (no changes will be written)\n')
    } else {
      console.log('⚡ Running migration (writing to database)\n')
    }

    const progress = await migrateUsersToOrganizations(stores, {
      dryRun,
      onProgress: (p) => {
        if (
          p.processedUsers % Math.max(1, Math.floor(p.totalUsers / 10)) === 0 ||
          p.processedUsers === p.totalUsers
        ) {
          const pct = Math.round((p.processedUsers / p.totalUsers) * 100)
          process.stdout.write(
            `\r  [${pct}%] ${p.processedUsers}/${p.totalUsers} users | ` +
              `${p.migratedOrganizations} orgs | ` +
              `${p.migratedSubscriptions} subscriptions | ` +
              `${p.migratedWorkspaces} workspaces`,
          )
        }
      },
    })

    console.log('\n')
    console.log(`📊 Migration Results:`)
    console.log(`  Total users:              ${progress.totalUsers}`)
    console.log(`  Processed:                ${progress.processedUsers}`)
    console.log(`  Created organizations:    ${progress.migratedOrganizations}`)
    console.log(`  Migrated subscriptions:   ${progress.migratedSubscriptions}`)
    console.log(`  Linked workspaces:        ${progress.migratedWorkspaces}`)
    console.log(`  Skipped (already migrated): ${progress.skippedUsers}`)

    if (progress.errors.length > 0) {
      console.log(`  ❌ Errors: ${progress.errors.length}`)
      progress.errors.forEach((err) => {
        console.log(`     - User ${err.userId}: ${err.error}`)
      })
    }

    if (dryRun) {
      console.log('\n✨ This was a dry-run. No changes were made.')
      console.log('   Run with --confirm to commit the migration.')
    } else {
      console.log('\n✅ Migration complete!')
    }

    if (progress.errors.length > 0) process.exitCode = 1
  } catch (error) {
    console.error('❌ Migration failed:', error)
    process.exitCode = 1
  } finally {
    await storage.close()
  }
}

main().catch((error) => {
  console.error('❌ Migration failed to start:', error)
  process.exitCode = 1
})
