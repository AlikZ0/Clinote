<script setup lang="ts">
/**
 * The passphrase, the recovery key and the choice to change either
 * (docs/encryption.md §5, §6, §7).
 *
 * Everything here is stated plainly, including the part we cannot fix: a lost
 * passphrase and a lost recovery key together mean the cloud copies are gone.
 */
const { canUse } = useFeatureAccess()
const { isAuthenticated } = useAuth()
const { t } = useI18n()
const encryption = useEncryption()
const workspace = useWorkspace()

const passphrase = ref('')
const confirmation = ref('')
const acknowledged = ref(false)
const recoveryInput = ref('')
const mode = ref<'passphrase' | 'recovery'>('passphrase')
const changing = ref(false)
const copied = ref(false)

/**
 * Who gets to set a passphrase.
 *
 * Their own paid plan — or membership of somebody else's workspace. A colleague
 * invited into a clinic is usually on the Free plan, and without a passphrase
 * they have no identity key; without an identity key nobody can hand them the
 * workspace key, and the invitation goes nowhere
 * (docs/encryption.md §9).
 */
const eligible = computed(
  () => isAuthenticated.value && (canUse('cloudSync') || workspace.workspaces.value.length > 0),
)

onMounted(async () => {
  if (eligible.value) await encryption.refresh()
})

watch(eligible, async (value) => {
  if (value) await encryption.refresh()
})

const mismatch = computed(
  () => confirmation.value.length > 0 && passphrase.value !== confirmation.value,
)

function clear(): void {
  passphrase.value = ''
  confirmation.value = ''
  recoveryInput.value = ''
  acknowledged.value = false
}

async function setUp(): Promise<void> {
  if (mismatch.value || !acknowledged.value) return
  if (await encryption.setUp(passphrase.value)) clear()
}

async function unlock(): Promise<void> {
  const ok =
    mode.value === 'passphrase'
      ? await encryption.unlock(passphrase.value)
      : await encryption.unlockWithRecovery(recoveryInput.value)
  if (ok) clear()
}

function cancelChange(): void {
  changing.value = false
  clear()
}

async function change(): Promise<void> {
  if (mismatch.value || passphrase.value.length < 10) return
  if (await encryption.changePassphrase(passphrase.value)) {
    changing.value = false
    clear()
  }
}

async function copyRecoveryKey(): Promise<void> {
  const key = encryption.recoveryKey.value
  if (!key) return
  try {
    await navigator.clipboard.writeText(key)
    copied.value = true
  } catch {
    // Clipboard permission is not something to argue with; the key is on screen.
    copied.value = false
  }
}
</script>

<template>
  <div v-if="eligible" class="card stack stack--tight">
    <h2>{{ t('encryption.title') }}</h2>

    <!-- Shown once, right after setup or a passphrase change. -->
    <div v-if="encryption.recoveryKey.value" class="recovery stack stack--tight">
      <h3>{{ t('encryption.recoveryTitle') }}</h3>
      <p class="hint">{{ t('encryption.recoveryBody') }}</p>
      <code class="recovery__key">{{ encryption.recoveryKey.value }}</code>
      <div class="row wrap">
        <button type="button" class="button" @click="copyRecoveryKey">
          {{ copied ? t('encryption.copied') : t('encryption.copy') }}
        </button>
        <button
          type="button"
          class="button button--primary"
          @click="encryption.acknowledgeRecoveryKey()"
        >
          {{ t('encryption.savedIt') }}
        </button>
      </div>
    </div>

    <template v-if="encryption.state.value === 'not_set_up'">
      <p class="hint">{{ t('encryption.setupBody') }}</p>
      <label class="field">
        <span>{{ t('encryption.passphrase') }}</span>
        <input v-model="passphrase" class="input" type="password" autocomplete="new-password" />
      </label>
      <label class="field">
        <span>{{ t('encryption.repeatPassphrase') }}</span>
        <input v-model="confirmation" class="input" type="password" autocomplete="new-password" />
      </label>
      <p v-if="mismatch" class="hint warn">{{ t('encryption.mismatch') }}</p>
      <label class="checkbox">
        <input v-model="acknowledged" type="checkbox" />
        <span>{{ t('encryption.acknowledge') }}</span>
      </label>
      <button
        type="button"
        class="button button--primary"
        :disabled="encryption.busy.value || passphrase.length < 10 || mismatch || !acknowledged"
        @click="setUp"
      >
        {{ encryption.busy.value ? t('encryption.settingUp') : t('encryption.setUpAction') }}
      </button>
    </template>

    <template v-else-if="encryption.state.value === 'locked'">
      <p class="hint">{{ t('encryption.lockedBody') }}</p>

      <div class="row wrap">
        <button
          type="button"
          class="button"
          :class="{ 'button--primary': mode === 'passphrase' }"
          @click="mode = 'passphrase'"
        >
          {{ t('encryption.passphrase') }}
        </button>
        <button
          type="button"
          class="button"
          :class="{ 'button--primary': mode === 'recovery' }"
          @click="mode = 'recovery'"
        >
          {{ t('encryption.recoveryKeyTab') }}
        </button>
      </div>

      <label v-if="mode === 'passphrase'" class="field">
        <span>{{ t('encryption.passphrase') }}</span>
        <input v-model="passphrase" class="input" type="password" autocomplete="current-password" />
      </label>
      <label v-else class="field">
        <span>{{ t('encryption.recoveryKeyTab') }}</span>
        <input
          v-model="recoveryInput"
          class="input"
          autocomplete="off"
          spellcheck="false"
          placeholder="XXXX-XXXX-XXXX-…"
        />
        <span class="hint">{{ t('encryption.recoveryHint') }}</span>
      </label>

      <button
        type="button"
        class="button button--primary"
        :disabled="encryption.busy.value"
        @click="unlock"
      >
        {{ encryption.busy.value ? t('encryption.unlocking') : t('encryption.unlock') }}
      </button>
    </template>

    <template v-else-if="encryption.state.value === 'unlocked'">
      <p class="hint">{{ t('encryption.unlockedBody') }}</p>

      <template v-if="changing">
        <label class="field">
          <span>{{ t('encryption.newPassphrase') }}</span>
          <input v-model="passphrase" class="input" type="password" autocomplete="new-password" />
        </label>
        <label class="field">
          <span>{{ t('encryption.repeatNewPassphrase') }}</span>
          <input v-model="confirmation" class="input" type="password" autocomplete="new-password" />
        </label>
        <p v-if="mismatch" class="hint warn">{{ t('encryption.mismatch') }}</p>
        <p class="hint">{{ t('encryption.rotationNote') }}</p>
        <div class="row wrap">
          <button type="button" class="button" @click="cancelChange">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="button button--primary"
            :disabled="encryption.busy.value || passphrase.length < 10 || mismatch"
            @click="change"
          >
            {{
              encryption.busy.value ? t('encryption.changing') : t('encryption.changePassphrase')
            }}
          </button>
        </div>
      </template>

      <div v-else class="row wrap">
        <button type="button" class="button" @click="changing = true">
          {{ t('encryption.changePassphrase') }}
        </button>
        <button type="button" class="button" @click="encryption.lock()">
          {{ t('encryption.lockDevice') }}
        </button>
      </div>
    </template>

    <p v-if="encryption.errorMessage.value" class="hint warn">
      {{ encryption.errorMessage.value }}
    </p>
  </div>
</template>

<style scoped>
.recovery {
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  padding: var(--space-3);
  background: var(--accent-soft);
}

.recovery h3 {
  margin: 0;
}

.recovery__key {
  display: block;
  word-break: break-all;
  line-height: 1.8;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--surface);
  font-size: 0.9375rem;
  letter-spacing: 0.06em;
}
</style>
