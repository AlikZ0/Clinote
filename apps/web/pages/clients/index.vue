<script setup lang="ts">
const { items, query, loading, hasMore, errorMessage, refresh, loadMore } = useClientList()
const { t } = useI18n()

onMounted(refresh)
onActivated(refresh)
</script>

<template>
  <section class="stack">
    <div class="row">
      <h1>{{ t('clients.title') }}</h1>
      <NuxtLink to="/clients/new" class="button button--primary">
        {{ t('clients.newClient') }}
      </NuxtLink>
    </div>

    <label class="field">
      <span class="visually-hidden">{{ t('clients.search') }}</span>
      <input
        v-model="query"
        class="input"
        type="search"
        inputmode="search"
        autocomplete="off"
        :placeholder="t('clients.search')"
      />
    </label>

    <p v-if="errorMessage" class="alert" role="alert">{{ errorMessage }}</p>

    <ul v-if="items.length" class="list">
      <li v-for="client in items" :key="client.id">
        <NuxtLink :to="`/clients/${client.id}`" class="list-item">
          <span>
            <span class="list-item__title">{{ client.lastName }} {{ client.firstName }}</span>
            <br />
            <span class="list-item__meta">{{
              t('clients.since', { date: client.arrivalDate })
            }}</span>
          </span>
          <span aria-hidden="true" class="chevron">›</span>
        </NuxtLink>
      </li>
    </ul>

    <p v-else-if="!loading" class="empty">
      {{ query ? t('clients.noMatch') : t('clients.empty') }}
    </p>

    <button
      v-if="hasMore"
      type="button"
      class="button button--block"
      :disabled="loading"
      @click="loadMore"
    >
      {{ loading ? t('common.loading') : t('clients.loadMore') }}
    </button>
  </section>
</template>

<style scoped>
.chevron {
  color: var(--text-muted);
}
</style>
