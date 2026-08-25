import { describe, expect, it } from 'vitest'
import { ROLE_PERMISSIONS, can, permissions, workspaceRoles } from './workspaces'

describe('roles', () => {
  it('gives the owner everything', () => {
    for (const permission of permissions) expect(can('owner', permission)).toBe(true)
  })

  it('keeps the workspace itself out of an admin’s hands', () => {
    // An admin runs the team; only the owner can rename or delete the practice.
    expect(can('admin', 'members.manage')).toBe(true)
    expect(can('admin', 'workspace.manage')).toBe(false)
  })

  it('lets a viewer read and receive, and nothing else', () => {
    expect(can('viewer', 'clients.read')).toBe(true)
    // Receiving is how reading works in a synced product.
    expect(can('viewer', 'sync.participate')).toBe(true)
    expect(can('viewer', 'clients.write')).toBe(false)
    expect(can('viewer', 'appointments.manage')).toBe(false)
  })

  it('lets an assistant book and edit but not delete', () => {
    expect(can('assistant', 'appointments.manage')).toBe(true)
    expect(can('assistant', 'clients.write')).toBe(true)
    expect(can('assistant', 'clients.delete')).toBe(false)
  })

  it('keeps the audit log away from the people it records', () => {
    // Everyone is logged; only the people accountable for the practice read it.
    expect(can('doctor', 'audit.read')).toBe(false)
    expect(can('assistant', 'audit.read')).toBe(false)
    expect(can('admin', 'audit.read')).toBe(true)
  })

  it('is strictly nested: every role is a subset of the one above it', () => {
    // Not a stylistic preference — a gap here would mean a demotion could
    // *grant* a permission, which no one would think to test for.
    const order = ['viewer', 'assistant', 'doctor', 'admin', 'owner'] as const
    for (let index = 1; index < order.length; index += 1) {
      const lower = ROLE_PERMISSIONS[order[index - 1]!]
      const higher = ROLE_PERMISSIONS[order[index]!]
      for (const permission of lower) expect(higher).toContain(permission)
    }
  })

  it('grants every role the ability to take part in sync', () => {
    // A member who cannot receive envelopes is a member of nothing.
    for (const role of workspaceRoles) expect(can(role, 'sync.participate')).toBe(true)
  })
})
