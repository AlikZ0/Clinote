<script setup lang="ts">
/**
 * The team screen (product spec §41–§44).
 *
 * Four things happen here, in the order a practice actually needs them:
 * create or join a workspace, invite people, give them access to the encrypted
 * data, and read the log of what everyone did.
 */
import type { AuditEvent, WorkspaceRole } from '@clinote/types'
import type { PendingGrant, WorkspaceMemberView } from '~/composables/useWorkspace'

const { t, tag } = useI18n()
const workspace = useWorkspace()
const { isAuthenticated } = useAuth()
const encryption = useEncryption()

const name = ref('')
const inviteEmail = ref('')
const inviteRole = ref<WorkspaceRole>('assistant')
const inviteToken = ref<string | null>(null)
const joinToken = ref('')
const members = ref<WorkspaceMemberView[]>([])
const pending = ref<PendingGrant[]>([])
const events = ref<AuditEvent[]>([])
const removing = ref<string | null>(null)

const roleOptions: WorkspaceRole[] = ['admin', 'doctor', 'assistant', 'viewer']

const inWorkspace = computed(() => workspace.activeId.value !== null)

onMounted(async () => {
  if (!isAuthenticated.value) return
  await workspace.refresh()
  await load()
})

// The shell establishes the workspace and its key asynchronously. Reacting to
// that is what keeps this screen right regardless of which finished first.
watch([workspace.activeId, workspace.keyState], async () => {
  if (isAuthenticated.value) await load()
})

async function load(): Promise<void> {
  if (!inWorkspace.value) {
    members.value = []
    pending.value = []
    events.value = []
    return
  }
  members.value = await workspace.members()
  pending.value = await workspace.pendingGrants()
  events.value = await workspace.auditEvents()
}

async function createWorkspace(): Promise<void> {
  if (name.value.trim().length === 0) return
  if (await workspace.create(name.value.trim())) {
    name.value = ''
    await load()
  }
}

async function sendInvite(): Promise<void> {
  if (inviteEmail.value.trim().length === 0) return
  inviteToken.value = await workspace.invite(inviteEmail.value.trim(), inviteRole.value)
  inviteEmail.value = ''
  await load()
}

async function acceptInvite(): Promise<void> {
  if (joinToken.value.trim().length === 0) return
  if (await workspace.join(joinToken.value.trim())) {
    joinToken.value = ''
    await load()
  }
}

async function grant(member: PendingGrant): Promise<void> {
  if (await workspace.grantAccess(member)) await load()
}

async function changeRole(member: WorkspaceMemberView, role: WorkspaceRole): Promise<void> {
  if (await workspace.changeRole(member.userId, role)) await load()
}

async function confirmRemove(userId: string): Promise<void> {
  removing.value = userId
}

async function remove(userId: string): Promise<void> {
  removing.value = null
  if (await workspace.removeMember(userId)) await load()
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(tag.value, { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(value),
  )
}

/** An action name is a key, so the log reads in the member's own language. */
function describeAction(action: string): string {
  const key = `audit.${action}` as Parameters<typeof t>[0]
  const translated = t(key)
  return translated === key ? action : translated
}
</script>

<template>
  <section class="stack">
    <header class="stack stack--tight">
      <h1>{{ t('workspace.title') }}</h1>
      <p class="hint">{{ t('workspace.intro') }}</p>
    </header>

    <div v-if="!isAuthenticated" class="card">
      <p class="hint">{{ t('workspace.signInFirst') }}</p>
      <NuxtLink to="/settings" class="button button--primary">{{ t('common.settings') }}</NuxtLink>
    </div>

    <template v-else>
      <!-- Joining needs no subscription: the clinic that invited you pays. -->
      <div class="card stack stack--tight">
        <h2>{{ t('workspace.joinTitle') }}</h2>
        <p class="hint">{{ t('workspace.joinBody') }}</p>
        <label class="field">
          <span>{{ t('workspace.inviteCode') }}</span>
          <input v-model="joinToken" class="input" autocomplete="off" spellcheck="false" />
        </label>
        <button
          type="button"
          class="button button--primary"
          :disabled="workspace.busy.value"
          @click="acceptInvite"
        >
          {{ t('workspace.join') }}
        </button>
      </div>

      <div v-if="workspace.available.value" class="card stack stack--tight">
        <h2>{{ t('workspace.createTitle') }}</h2>
        <p class="hint">{{ t('workspace.createBody') }}</p>
        <p v-if="encryption.state.value !== 'unlocked'" class="hint warn">
          {{ t('workspace.needsEncryption') }}
        </p>
        <label class="field">
          <span>{{ t('workspace.name') }}</span>
          <input v-model="name" class="input" :placeholder="t('workspace.namePlaceholder')" />
        </label>
        <button
          type="button"
          class="button button--primary"
          :disabled="workspace.busy.value || encryption.state.value !== 'unlocked'"
          @click="createWorkspace"
        >
          {{ t('workspace.create') }}
        </button>
      </div>

      <FeatureGate
        v-else
        feature="workspaces"
        :title="t('workspace.createTitle')"
        :description="t('workspace.businessOnly')"
      />

      <template v-if="inWorkspace">
        <div v-if="workspace.keyState.value === 'awaiting'" class="card stack stack--tight">
          <h2>{{ t('workspace.awaitingTitle') }}</h2>
          <p class="hint">{{ t('workspace.awaitingBody') }}</p>
        </div>

        <div class="card stack stack--tight">
          <h2>{{ t('workspace.members') }}</h2>
          <ul class="list">
            <li v-for="member in members" :key="member.userId" class="list-item">
              <div class="stack stack--tight">
                <strong>{{ member.email ?? member.userId }}</strong>
                <span class="hint">
                  {{ t(`workspace.role.${member.role}` as never) }}
                  <template v-if="!member.hasKey"> · {{ t('workspace.noAccessYet') }}</template>
                </span>
              </div>

              <div
                v-if="workspace.allows('members.manage') && member.role !== 'owner'"
                class="row wrap"
              >
                <select
                  class="input input--compact"
                  :value="member.role"
                  @change="
                    changeRole(member, ($event.target as HTMLSelectElement).value as WorkspaceRole)
                  "
                >
                  <option v-for="option in roleOptions" :key="option" :value="option">
                    {{ t(`workspace.role.${option}` as never) }}
                  </option>
                </select>
                <button
                  v-if="removing !== member.userId"
                  type="button"
                  class="button button--quiet"
                  @click="confirmRemove(member.userId)"
                >
                  {{ t('workspace.remove') }}
                </button>
                <button
                  v-else
                  type="button"
                  class="button button--danger"
                  @click="remove(member.userId)"
                >
                  {{ t('workspace.confirmRemove') }}
                </button>
              </div>
            </li>
          </ul>
        </div>

        <div
          v-if="pending.length > 0 && workspace.allows('members.manage')"
          class="card stack stack--tight"
        >
          <h2>{{ t('workspace.grantTitle') }}</h2>
          <p class="hint">{{ t('workspace.grantBody') }}</p>
          <ul class="list">
            <li v-for="member in pending" :key="member.userId" class="list-item">
              <div class="stack stack--tight">
                <strong>{{ member.email ?? member.userId }}</strong>
                <span v-if="!member.publicKey" class="hint warn">
                  {{ t('workspace.notReadyForKey') }}
                </span>
              </div>
              <button
                type="button"
                class="button button--primary"
                :disabled="!member.publicKey || workspace.keyState.value !== 'ready'"
                @click="grant(member)"
              >
                {{ t('workspace.grant') }}
              </button>
            </li>
          </ul>
        </div>

        <div v-if="workspace.allows('members.invite')" class="card stack stack--tight">
          <h2>{{ t('workspace.inviteTitle') }}</h2>
          <label class="field">
            <span>{{ t('common.email') }}</span>
            <input v-model="inviteEmail" class="input" type="email" autocomplete="off" />
          </label>
          <label class="field">
            <span>{{ t('workspace.roleLabel') }}</span>
            <select v-model="inviteRole" class="input">
              <option v-for="option in roleOptions" :key="option" :value="option">
                {{ t(`workspace.role.${option}` as never) }}
              </option>
            </select>
          </label>
          <button
            type="button"
            class="button button--primary"
            :disabled="workspace.busy.value"
            @click="sendInvite"
          >
            {{ t('workspace.sendInvite') }}
          </button>
          <p v-if="inviteToken" class="hint">
            {{ t('workspace.inviteSent') }}
            <code class="token">{{ inviteToken }}</code>
          </p>
        </div>

        <div v-if="workspace.allows('audit.read')" class="card stack stack--tight">
          <h2>{{ t('workspace.auditTitle') }}</h2>
          <p class="hint">{{ t('workspace.auditBody') }}</p>
          <ul v-if="events.length > 0" class="list">
            <li v-for="event in events" :key="event.id" class="list-item">
              <div class="stack stack--tight">
                <strong>{{ describeAction(event.action) }}</strong>
                <span class="hint">{{ event.actorEmail ?? t('workspace.unknownActor') }}</span>
              </div>
              <time class="hint">{{ formatTime(event.createdAt) }}</time>
            </li>
          </ul>
          <p v-else class="hint">{{ t('workspace.auditEmpty') }}</p>
        </div>
      </template>

      <p v-if="workspace.errorMessage.value" class="hint warn">
        {{ workspace.errorMessage.value }}
      </p>
    </template>
  </section>
</template>

<style scoped>
.list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.token {
  display: block;
  margin-top: var(--space-2);
  padding: var(--space-2);
  border-radius: var(--radius-sm);
  background: var(--surface-sunken);
  word-break: break-all;
  font-size: 0.8125rem;
}

.input--compact {
  min-height: 34px;
  padding-block: 0;
  font-size: 0.8125rem;
}
</style>
