<script setup lang="ts">
/**
 * File viewer. The original is fetched only here, on demand, and its object URL
 * is revoked when the page unmounts (product spec §67).
 */
import type { FileMeta } from '@clinote/types'
import { formatBytes } from '~/utils/format'

const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const fileId = computed(() => String(route.params.id))

const file = ref<FileMeta | null>(null)
const errorMessage = ref<string | null>(null)
const loading = ref(true)
const confirmingDelete = ref(false)
const { url, set } = useObjectUrl()

const isImage = computed(() => file.value?.mimeType.startsWith('image/') ?? false)
const isPdf = computed(() => file.value?.mimeType === 'application/pdf')

onMounted(async () => {
  try {
    const services = await useServices()
    file.value = await services.files.get(fileId.value)
    if (file.value) set(await services.files.getOriginal(fileId.value))
  } catch (error) {
    errorMessage.value = describeError(error)
  } finally {
    loading.value = false
  }
})

async function removeFile(): Promise<void> {
  if (!file.value) return
  const clientId = file.value.clientId
  try {
    const services = await useServices()
    await services.files.remove(file.value.id)
    await router.replace(`/clients/${clientId}`)
  } catch (error) {
    errorMessage.value = describeError(error)
  }
}
</script>

<template>
  <section class="stack">
    <p v-if="errorMessage" class="alert" role="alert">{{ errorMessage }}</p>

    <template v-if="file">
      <div class="row">
        <h1 class="filename">{{ file.name }}</h1>
        <NuxtLink :to="`/clients/${file.clientId}`" class="button">
          {{ t('files.backToClient') }}
        </NuxtLink>
      </div>

      <div class="viewer">
        <img v-if="isImage && url" :src="url" :alt="file.name" />
        <iframe v-else-if="isPdf && url" :src="url" :title="file.name" />
        <p v-else class="hint">{{ t('files.cannotPreview') }}</p>
      </div>

      <p class="hint">
        {{ file.mimeType }} · {{ formatBytes(file.size) }} ·
        {{ t('files.added', { date: file.createdAt.slice(0, 10) }) }}
      </p>

      <button
        v-if="!confirmingDelete"
        type="button"
        class="button button--danger"
        @click="confirmingDelete = true"
      >
        {{ t('files.deleteAction') }}
      </button>
      <div v-else class="row wrap">
        <button type="button" class="button" @click="confirmingDelete = false">
          {{ t('common.cancel') }}
        </button>
        <button type="button" class="button button--danger" @click="removeFile">
          {{ t('clients.deleteYes') }}
        </button>
      </div>
    </template>

    <p v-else-if="!loading" class="empty">{{ t('files.notStored') }}</p>
  </section>
</template>

<style scoped>
.filename {
  font-size: 1.125rem;
  word-break: break-word;
}

.viewer {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--surface-sunken);
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 14rem;
}

.viewer img {
  max-width: 100%;
  height: auto;
  display: block;
}

.viewer iframe {
  width: 100%;
  height: 70dvh;
  border: 0;
}
</style>
