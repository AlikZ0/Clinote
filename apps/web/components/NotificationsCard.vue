<script setup lang="ts">
/**
 * Reminder settings (product spec §61).
 *
 * Two columns, because push and email are genuinely different promises: push
 * can name the client, email never does (docs/notifications.md §2).
 */
import type { NotificationPreferences } from '@clinote/types'

import type { MessageKey } from '~/composables/useI18n'

const notifications = useNotifications()
const { canUse } = useFeatureAccess()
const { isAuthenticated } = useAuth()
const { t } = useI18n()

const rows = [
  { group: 'appointments', key: 'tomorrow', label: 'appointment.reminderDay' },
  { group: 'appointments', key: 'twoHours', label: 'appointment.reminderTwoHours' },
  { group: 'appointments', key: 'thirtyMinutes', label: 'appointment.reminderThirtyMinutes' },
  { group: 'backup', key: 'completed', label: 'notifications.backupCompleted' },
  { group: 'backup', key: 'failed', label: 'notifications.backupFailed' },
] as const

onMounted(async () => {
  if (notifications.eligible.value) await notifications.refresh()
})

watch(notifications.eligible, async (value) => {
  if (value) await notifications.refresh()
})

function toggleOf(group: string, key: string, channel: 'push' | 'email'): boolean {
  const preferences = notifications.preferences.value as unknown as Record<
    string,
    Record<string, Record<string, boolean>>
  >
  return preferences[group]?.[key]?.[channel] ?? false
}

async function setToggle(
  group: string,
  key: string,
  channel: 'push' | 'email',
  value: boolean,
): Promise<void> {
  const current = JSON.parse(
    JSON.stringify(notifications.preferences.value),
  ) as NotificationPreferences
  const mutable = current as unknown as Record<string, Record<string, Record<string, boolean>>>
  const target = mutable[group]?.[key]
  if (!target) return

  target[channel] = value
  await notifications.save(current)
}

const pushLabel = computed(() => {
  switch (notifications.pushState.value) {
    case 'on':
      return t('notifications.pushOn')
    case 'denied':
      return t('notifications.pushDenied')
    case 'unsupported':
      return t('notifications.pushUnsupported')
    default:
      return t('notifications.pushOff')
  }
})
</script>

<template>
  <div v-if="canUse('notifications')" class="card stack stack--tight">
    <h2>{{ t('notifications.title') }}</h2>

    <template v-if="!isAuthenticated">
      <p class="hint">{{ t('notifications.signIn') }}</p>
      <NuxtLink to="/auth/login" class="button button--primary">{{ t('common.signIn') }}</NuxtLink>
    </template>

    <template v-else>
      <p class="hint">{{ pushLabel }}</p>
      <div class="row wrap">
        <button
          v-if="notifications.pushState.value === 'off'"
          type="button"
          class="button button--primary"
          :disabled="notifications.busy.value"
          @click="notifications.enablePush()"
        >
          {{ t('notifications.turnOnPush') }}
        </button>
        <button
          v-else-if="notifications.pushState.value === 'on'"
          type="button"
          class="button"
          :disabled="notifications.busy.value"
          @click="notifications.disablePush()"
        >
          {{ t('notifications.turnOffPush') }}
        </button>
      </div>

      <table class="toggles">
        <thead>
          <tr>
            <th scope="col">{{ t('notifications.remindMe') }}</th>
            <th scope="col">{{ t('notifications.push') }}</th>
            <th scope="col">{{ t('notifications.email') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="`${row.group}.${row.key}`">
            <th scope="row">{{ t(row.label as MessageKey) }}</th>
            <td v-for="channel in ['push', 'email'] as const" :key="channel">
              <label class="visually-hidden" :for="`${row.group}-${row.key}-${channel}`">
                {{ t(row.label as MessageKey) }} — {{ channel }}
              </label>
              <input
                :id="`${row.group}-${row.key}-${channel}`"
                type="checkbox"
                :checked="toggleOf(row.group, row.key, channel)"
                :disabled="notifications.busy.value"
                @change="
                  setToggle(
                    row.group,
                    row.key,
                    channel,
                    ($event.target as HTMLInputElement).checked,
                  )
                "
              />
            </td>
          </tr>
        </tbody>
      </table>

      <p class="hint">{{ t('notifications.channelNote') }}</p>
      <p class="hint">{{ t('notifications.securityNote') }}</p>
      <p v-if="notifications.errorMessage.value" class="hint warn">
        {{ notifications.errorMessage.value }}
      </p>
    </template>
  </div>
</template>

<style scoped>
.buttons {
  flex-wrap: wrap;
  justify-content: flex-start;
}

.toggles {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.toggles th,
.toggles td {
  padding: 0.5rem 0.25rem;
  text-align: left;
  border-bottom: 1px solid var(--border);
}

.toggles thead th {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.toggles td {
  text-align: center;
  width: 4.5rem;
}

.toggles input {
  min-width: 1.25rem;
  min-height: 1.25rem;
}

.toggles tbody th {
  font-weight: 400;
}
</style>
