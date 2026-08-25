<script setup lang="ts">
import { DEFAULT_PLANS } from '@clinote/config'
import type { Device } from '@clinote/types'
import { getLocalCore } from '~/database'
import { LOCALES, LOCALE_NAMES, type Locale } from '~/i18n'
import { formatDateTime } from '~/utils/format'

const { planId, previewPlanId, isPreview, setPreviewPlan, loadPreviewPlan } = useFeatureAccess()
const { user, status, isAuthenticated, logout } = useAuth()
const { locale, setLocale, t } = useI18n()
const subscription = useSubscription()
const config = useRuntimeConfig()

const devices = ref<Device[]>([])
const devicesError = ref<string | null>(null)
const thisDeviceId = ref<string | null>(null)
const confirmingCancel = ref(false)
const cancelRequested = ref(false)

onMounted(async () => {
  await loadPreviewPlan()
  try {
    thisDeviceId.value = (await getLocalCore()).context.deviceId
  } catch {
    thisDeviceId.value = null
  }
  await loadDevices()
  await subscription.refresh()
})

watch(isAuthenticated, async () => {
  await loadDevices()
  await subscription.refresh()
})

async function loadDevices(): Promise<void> {
  if (!isAuthenticated.value) {
    devices.value = []
    return
  }
  try {
    devices.value = await useApi().request<Device[]>('/devices')
  } catch (error) {
    devicesError.value = describeError(error)
  }
}

async function removeDevice(id: string): Promise<void> {
  try {
    await useApi().request(`/devices/${id}`, { method: 'DELETE' })
    await loadDevices()
  } catch (error) {
    devicesError.value = describeError(error)
  }
}

async function signOut(): Promise<void> {
  await logout()
  devices.value = []
  subscription.subscription.value = null
}

async function cancelSubscription(): Promise<void> {
  confirmingCancel.value = false
  // The provider's webhook is what ends access, so nothing visibly changes
  // here. Say so, rather than leaving the click looking ignored.
  cancelRequested.value = await subscription.cancel()
}

function priceLabel(amount: number): string {
  return amount === 0
    ? t('settings.free')
    : t('settings.perMonth', { price: `$${(amount / 100).toFixed(2)}` })
}
</script>

<template>
  <section class="stack">
    <h1>{{ t('settings.title') }}</h1>

    <div class="card stack stack--tight">
      <h2>{{ t('settings.account') }}</h2>

      <template v-if="status === 'unknown'">
        <p class="hint">{{ t('settings.checkingSession') }}</p>
      </template>

      <template v-else-if="isAuthenticated && user">
        <dl class="details">
          <dt>{{ t('settings.signedInAs') }}</dt>
          <dd>{{ user.email }}</dd>
        </dl>
        <p class="hint">{{ t('settings.accountNote') }}</p>

        <template v-if="devices.length">
          <h3 class="subhead">{{ t('settings.devices') }}</h3>
          <ul class="list">
            <li v-for="device in devices" :key="device.id" class="list-item">
              <span>
                <span class="list-item__title">
                  {{ device.name }}
                  <template v-if="device.id === thisDeviceId">
                    · {{ t('settings.thisDevice') }}
                  </template>
                </span>
                <br />
                <span class="list-item__meta">
                  {{ device.platform }}
                  <template v-if="device.lastSeen">
                    · {{ t('settings.lastUsed', { date: formatDateTime(device.lastSeen) }) }}
                  </template>
                </span>
              </span>
              <button
                v-if="device.id !== thisDeviceId"
                type="button"
                class="button button--danger"
                @click="removeDevice(device.id)"
              >
                {{ t('settings.removeDevice') }}
              </button>
            </li>
          </ul>
          <p class="hint">{{ t('settings.removeDeviceNote') }}</p>
        </template>
        <p v-if="devicesError" class="hint warn">{{ devicesError }}</p>

        <button type="button" class="button" @click="signOut">{{ t('common.signOut') }}</button>
      </template>

      <template v-else>
        <p class="hint">{{ t('settings.signedOutNote') }}</p>
        <div class="row wrap">
          <NuxtLink to="/auth/login" class="button button--primary">
            {{ t('common.signIn') }}
          </NuxtLink>
          <NuxtLink to="/auth/register" class="button">{{ t('settings.createAccount') }}</NuxtLink>
        </div>
      </template>
    </div>

    <EncryptionCard />

    <SyncCard />

    <NotificationsCard />

    <StorageGuardCard />

    <div class="card stack stack--tight">
      <h2>{{ t('settings.plans') }}</h2>

      <ul class="list">
        <li v-for="plan in DEFAULT_PLANS" :key="plan.id" class="list-item">
          <span>
            <span class="list-item__title">{{ plan.name }}</span>
            <br />
            <span class="list-item__meta">{{ priceLabel(plan.price.amount) }}</span>
          </span>
          <span v-if="plan.id === planId" class="badge badge--ok">{{ t('settings.current') }}</span>
          <button
            v-else-if="isAuthenticated && plan.id !== 'free'"
            type="button"
            class="button button--primary"
            :disabled="subscription.busy.value"
            @click="subscription.upgrade(plan.id)"
          >
            {{ t('settings.upgrade') }}
          </button>
        </li>
      </ul>

      <template v-if="subscription.subscription.value">
        <dl class="details">
          <dt>{{ t('settings.subscriptionStatus') }}</dt>
          <dd>{{ subscription.subscription.value.status }}</dd>
        </dl>
        <p v-if="subscription.subscription.value.currentPeriodEnd" class="hint">
          {{
            subscription.subscription.value.status === 'active'
              ? t('settings.renewsOn', {
                  date: formatDateTime(subscription.subscription.value.currentPeriodEnd),
                })
              : t('settings.endsOn', {
                  date: formatDateTime(subscription.subscription.value.currentPeriodEnd),
                })
          }}
        </p>

        <p v-if="cancelRequested" class="hint warn">{{ t('settings.cancelRequested') }}</p>

        <template v-if="subscription.subscription.value.status === 'active' && !cancelRequested">
          <button
            v-if="!confirmingCancel"
            type="button"
            class="button button--danger"
            @click="confirmingCancel = true"
          >
            {{ t('settings.cancelSubscription') }}
          </button>
          <template v-else>
            <p class="hint warn">{{ t('settings.cancelConfirm') }}</p>
            <div class="row wrap">
              <button type="button" class="button" @click="confirmingCancel = false">
                {{ t('common.cancel') }}
              </button>
              <button type="button" class="button button--danger" @click="cancelSubscription">
                {{ t('clients.deleteYes') }}
              </button>
            </div>
          </template>
        </template>
      </template>

      <p class="hint">{{ t('settings.priceNote') }}</p>
      <p v-if="subscription.errorMessage.value" class="hint warn">
        {{ subscription.errorMessage.value }}
      </p>
    </div>

    <div class="card stack stack--tight">
      <h2>{{ t('settings.language') }}</h2>
      <div class="row wrap">
        <button
          v-for="value in LOCALES"
          :key="value"
          type="button"
          class="button"
          :class="{ 'button--primary': locale === value }"
          @click="setLocale(value as Locale)"
        >
          {{ LOCALE_NAMES[value] }}
        </button>
      </div>
      <p class="hint">{{ t('settings.languageNote') }}</p>
    </div>

    <div v-if="!isAuthenticated" class="card stack stack--tight preview">
      <div class="row">
        <h2>{{ t('settings.previewTitle') }}</h2>
        <span v-if="isPreview" class="badge badge--warn">{{ t('settings.previewActive') }}</span>
      </div>
      <p class="hint">{{ t('settings.previewNote') }}</p>
      <div class="row wrap">
        <button
          type="button"
          class="button"
          :class="{ 'button--primary': previewPlanId === null }"
          @click="setPreviewPlan(null)"
        >
          {{ t('settings.free') }}
        </button>
        <button
          v-for="plan in DEFAULT_PLANS.filter((item) => item.id !== 'free')"
          :key="plan.id"
          type="button"
          class="button"
          :class="{ 'button--primary': previewPlanId === plan.id }"
          @click="setPreviewPlan(plan.id)"
        >
          {{ plan.name }}
        </button>
      </div>
    </div>

    <div class="card stack stack--tight">
      <h2>{{ t('settings.about') }}</h2>
      <dl class="details">
        <dt>{{ t('settings.appVersion') }}</dt>
        <dd>{{ config.public.appVersion }}</dd>
        <dt>{{ t('settings.dataLocation') }}</dt>
        <dd>{{ t('settings.storedOnDevice') }}</dd>
      </dl>
      <NuxtLink to="/backup" class="button">{{ t('settings.exportOrImport') }}</NuxtLink>
    </div>
  </section>
</template>

<style scoped>
.subhead {
  margin: var(--space-2) 0 0;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}

.preview {
  border-style: dashed;
}
</style>
