<script setup lang="ts">
const router = useRouter()
const route = useRoute()
const { login, busy, errorMessage } = useAuth()
const { t } = useI18n()

const form = reactive({ email: '', password: '' })

async function submit(): Promise<void> {
  if (await login({ ...form })) {
    const next = typeof route.query.next === 'string' ? route.query.next : '/settings'
    await router.replace(next)
  }
}
</script>

<template>
  <section class="stack auth">
    <h1>{{ t('auth.signInTitle') }}</h1>
    <p class="hint">{{ t('auth.signInNote') }}</p>

    <p v-if="errorMessage" class="alert" role="alert">{{ errorMessage }}</p>

    <form class="card stack" @submit.prevent="submit">
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
          autocomplete="current-password"
          required
        />
      </label>

      <button type="submit" class="button button--primary button--block" :disabled="busy">
        {{ busy ? t('auth.signingIn') : t('common.signIn') }}
      </button>
    </form>

    <div class="row links">
      <NuxtLink to="/auth/register">{{ t('settings.createAccount') }}</NuxtLink>
      <NuxtLink to="/auth/forgot-password">{{ t('auth.forgotPassword') }}</NuxtLink>
    </div>
  </section>
</template>

<style scoped>
.auth {
  max-width: 26rem;
  margin-inline: auto;
}

.links {
  font-size: 0.875rem;
}
</style>
