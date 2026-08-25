<script setup lang="ts">
const { requestPasswordReset, busy, errorMessage } = useAuth()
const { t } = useI18n()

const email = ref('')
const sent = ref(false)

async function submit(): Promise<void> {
  if (await requestPasswordReset(email.value)) sent.value = true
}
</script>

<template>
  <section class="stack auth">
    <h1>{{ t('auth.resetTitle') }}</h1>

    <p v-if="errorMessage" class="alert" role="alert">{{ errorMessage }}</p>

    <template v-if="sent">
      <p class="hint">{{ t('auth.resetSent', { email }) }}</p>
      <NuxtLink to="/auth/login" class="button button--block">
        {{ t('auth.backToSignIn') }}
      </NuxtLink>
    </template>

    <form v-else class="card stack" @submit.prevent="submit">
      <label class="field">
        <span>{{ t('auth.email') }}</span>
        <input
          v-model="email"
          class="input"
          type="email"
          inputmode="email"
          autocomplete="email"
          required
        />
      </label>
      <button type="submit" class="button button--primary button--block" :disabled="busy">
        {{ busy ? t('auth.sending') : t('auth.sendResetLink') }}
      </button>
      <NuxtLink to="/auth/login" class="button button--block">{{ t('common.cancel') }}</NuxtLink>
    </form>
  </section>
</template>

<style scoped>
.auth {
  max-width: 26rem;
  margin-inline: auto;
}
</style>
