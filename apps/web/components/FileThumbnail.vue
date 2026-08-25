<script setup lang="ts">
/**
 * Renders the stored preview, never the original (docs/indexeddb.md §4).
 * Falls back to a type icon when no thumbnail could be generated.
 */
import type { FileMeta } from '@clinote/types'

const props = defineProps<{ file: FileMeta }>()
const { url, set } = useObjectUrl()

onMounted(async () => {
  try {
    const services = await useServices()
    set(await services.files.getThumbnail(props.file.id))
  } catch {
    set(null)
  }
})

const icon = computed(() => (props.file.mimeType === 'application/pdf' ? '📄' : '🖼️'))
</script>

<template>
  <span class="thumb">
    <img v-if="url" :src="url" :alt="file.name" loading="lazy" />
    <span v-else aria-hidden="true" class="thumb__icon">{{ icon }}</span>
  </span>
</template>

<style scoped>
.thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  overflow: hidden;
}

.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumb__icon {
  font-size: 1.75rem;
}
</style>
