<script setup lang="ts">
/**
 * Picks a client by surname.
 *
 * A `<select>` would need every client in the DOM; this uses the same
 * index-backed prefix search as the client list, so it stays usable at 1,000+
 * clients (product spec §66).
 */
import type { Client } from '@clinote/types'

const model = defineModel<Client | null>({ required: true })

const { t } = useI18n()

const query = ref('')
const results = ref<Client[]>([])
const searching = ref(false)

let timer: ReturnType<typeof setTimeout> | undefined

watch(query, (value) => {
  clearTimeout(timer)
  if (!value.trim()) {
    results.value = []
    return
  }
  timer = setTimeout(() => void search(value), 200)
})

async function search(value: string): Promise<void> {
  searching.value = true
  try {
    const services = await useServices()
    results.value = await services.clients.search(value, 8)
  } catch {
    results.value = []
  } finally {
    searching.value = false
  }
}

function choose(client: Client): void {
  model.value = client
  query.value = ''
  results.value = []
}
</script>

<template>
  <div class="picker stack stack--tight">
    <template v-if="model">
      <div class="row chosen">
        <span>
          <span class="list-item__title">{{ model.lastName }} {{ model.firstName }}</span>
          <br />
          <span class="list-item__meta">Since {{ model.arrivalDate }}</span>
        </span>
        <button type="button" class="button" @click="model = null">{{ t('common.edit') }}</button>
      </div>
    </template>

    <template v-else>
      <label class="field">
        <span>{{ t('appointment.client') }}</span>
        <input
          v-model="query"
          class="input"
          type="search"
          inputmode="search"
          autocomplete="off"
          :placeholder="t('clients.search')"
        />
      </label>

      <ul v-if="results.length" class="list">
        <li v-for="client in results" :key="client.id">
          <button type="button" class="list-item picker__option" @click="choose(client)">
            <span class="list-item__title">{{ client.lastName }} {{ client.firstName }}</span>
            <span aria-hidden="true">›</span>
          </button>
        </li>
      </ul>
      <p v-else-if="query && !searching" class="hint">{{ t('clients.noMatch') }}</p>
    </template>
  </div>
</template>

<style scoped>
.chosen {
  padding: 0.625rem 0.875rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.picker__option {
  width: 100%;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
</style>
