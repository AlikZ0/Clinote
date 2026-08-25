<script setup lang="ts">
import { PASSWORD_MIN_LENGTH } from '@clinote/types'

const router = useRouter()
const { register, busy, errorMessage } = useAuth()
const { t } = useI18n()

const form = reactive({ name: '', email: '', password: '' })

async function submit(): Promise<void> {
  const created = await register({
    email: form.email,
    password: form.password,
    name: form.name.trim() || undefined,
  })
  if (created) await router.replace('/settings')
}
</script>

<template>
  <section class="stack auth">
    <h1>{{ t('auth.registerTitle') }}</h1>
    <p class="hint">{{ t('auth.registerNote') }}</p>

    <p v-if="errorMessage" class="alert" role="alert">{{ errorMessage }}</p>

    <form class="card stack" @submit.prevent="submit">
      <label class="field">
        <span>{{ t('auth.name') }} ({{ t('common.optional') }})</span>
        <input v-model="form.name" class="input" autocomplete="name" />
      </label>

      <label class="field">
        <span>{{ t('auth.email') }}</span>
        <input
          v-model="form.email"
          class="input"
          type="email"
          inputmode="email"
          autocomplete="email"
          required
        />
      </label>

      <label class="field">
        <span>{{ t('auth.password') }}</span>
        <input
          v-model="form.password"
          class="input"
          type="password"
          autocomplete="new-password"
          :minlength="PASSWORD_MIN_LENGTH"
          required
        />
        <span class="hint">{{ t('auth.passwordHint', { count: PASSWORD_MIN_LENGTH }) }}</span>
      </label>

      <button type="submit" class="button button--primary button--block" :disabled="busy">
        {{ busy ? t('auth.creating') : t('auth.createAction') }}
      </button>
    </form>

    <p class="hint">
      {{ t('auth.haveAccount') }}
      <NuxtLink to="/auth/login">{{ t('common.signIn') }}</NuxtLink>
    </p>
  </section>
</template>

<style scoped>
.auth {
  max-width: 26rem;
  margin-inline: auto;
}
</style>
