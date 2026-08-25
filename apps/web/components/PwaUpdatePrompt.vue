<script setup lang="ts">
/**
 * Updates are offered, never applied silently (docs/deployment.md §5).
 *
 * A new build waits until the user says now is a good moment, so it cannot
 * interrupt an import, an export or a backup upload.
 */
const { needRefresh, applyUpdate } = useServiceWorker()
</script>

<template>
  <div v-if="needRefresh" class="update" role="status">
    <span>A new version of Clinote is ready.</span>
    <button type="button" class="button button--primary" @click="applyUpdate">Reload</button>
  </div>
</template>

<style scoped>
.update {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  flex-wrap: wrap;
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--accent-soft);
  margin: var(--space-3) var(--space-4) 0;
}
</style>
