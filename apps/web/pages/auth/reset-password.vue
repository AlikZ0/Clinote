<script setup lang="ts">
import { PASSWORD_MIN_LENGTH } from '@clinote/types'

const route = useRoute()
const router = useRouter()
const { resetPassword, busy, errorMessage } = useAuth()
const { t } = useI18n()

const token = computed(() => (typeof route.query.token === 'string' ? route.query.token : ''))
const password = ref('')
const done = ref(false)

async function submit(): Promise<void> {
  if (await resetPassword(token.value, password.value)) done.value = true
}
</script>

<template>
  <section class="stack auth">
    <h1>{{ t('auth.newPasswordTitle') }}</h1>

    <p v-if="!token" class="alert" role="alert">{{ t('auth.incompleteLink') }}</p>
    <p v-else-if="errorMessage" class="alert" role="alert">{{ errorMessage }}</p>

    <template v-if="done">
      <p class="hint">{{ t('auth.passwordChanged') }}</p>
      <button
        type="button"
        class="button button--primary button--block"
        @click="router.replace('/auth/login')"
      >
        {{ t('common.signIn') }}
      </button>
    </template>

    <form v-else-if="token" class="card stack" @submit.prevent="submit">
      <label class="field">
        <span>{{ t('auth.newPassword') }}</span>
        <input
          v-model="password"
          class="input"
          type="password"
          autocomplete="new-password"
          :minlength="PASSWORD_MIN_LENGTH"
          required
        />
      </label>
      <button type="submit" class="button button--primary button--block" :disabled="busy">
        {{ busy ? t('common.saving') : t('auth.changePassword') }}
      </button>
    </form>
  </section>
</template>

<style scoped>
.auth {
  max-width: 26rem;
  margin-inline: auto;
}
</style>
