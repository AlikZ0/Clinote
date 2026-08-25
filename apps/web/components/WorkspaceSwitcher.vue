<script setup lang="ts">
/**
 * Which dataset is open (product spec §44).
 *
 * Shown only when there is a choice to make. A single-practice user never sees
 * it, and a Free user never learns that their data is "the personal one".
 */
const { t } = useI18n()
const workspace = useWorkspace()
const { isAuthenticated } = useAuth()

const open = ref(false)

const visible = computed(
  () =>
    isAuthenticated.value && (workspace.workspaces.value.length > 0 || workspace.available.value),
)

const label = computed(() => workspace.active.value?.name ?? t('workspace.personal'))

async function choose(id: string | null): Promise<void> {
  open.value = false
  if (id === workspace.activeId.value) return
  await workspace.open(id)
  // Every screen reads the core it was given, so the simplest correct way to
  // show the new dataset is to start the page over. One navigation, not a
  // route change followed by a reload: two of them race each other, and
  // whichever lands second decides where the person ends up.
  if (import.meta.client) window.location.assign('/')
}
</script>

<template>
  <div v-if="visible" class="switcher">
    <button type="button" class="switcher__button" :aria-expanded="open" @click="open = !open">
      <span class="switcher__mark" aria-hidden="true">{{ label.slice(0, 1).toUpperCase() }}</span>
      <span class="switcher__name">{{ label }}</span>
      <span class="switcher__caret" aria-hidden="true">▾</span>
    </button>

    <div v-if="open" class="switcher__menu">
      <button type="button" class="switcher__item" @click="choose(null)">
        <span>{{ t('workspace.personal') }}</span>
        <span v-if="workspace.activeId.value === null" aria-hidden="true">✓</span>
      </button>

      <button
        v-for="item in workspace.workspaces.value"
        :key="item.id"
        type="button"
        class="switcher__item"
        @click="choose(item.id)"
      >
        <span>{{ item.name }}</span>
        <span v-if="workspace.activeId.value === item.id" aria-hidden="true">✓</span>
      </button>

      <NuxtLink to="/team" class="switcher__item switcher__item--link" @click="open = false">
        {{ t('workspace.manage') }}
      </NuxtLink>
    </div>
  </div>
</template>

<style scoped>
.switcher {
  position: relative;
}

.switcher__button {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 34px;
  padding: 0 0.55rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
}

.switcher__mark {
  display: grid;
  place-items: center;
  width: 1.35rem;
  height: 1.35rem;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent-strong);
  font-size: 0.6875rem;
  font-weight: 700;
}

.switcher__name {
  max-width: 9rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.switcher__caret {
  color: var(--text-muted);
  font-size: 0.6875rem;
}

.switcher__menu {
  position: absolute;
  right: 0;
  top: calc(100% + 0.4rem);
  min-width: 13rem;
  padding: 0.3rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-lg);
  z-index: 5;
}

.switcher__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: 100%;
  min-height: 38px;
  padding: 0 0.6rem;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 0.875rem;
  text-align: left;
  text-decoration: none;
  cursor: pointer;
}

.switcher__item:hover {
  background: var(--surface-sunken);
}

.switcher__item--link {
  margin-top: 0.2rem;
  border-top: 1px solid var(--border);
  border-radius: 0 0 var(--radius-sm) var(--radius-sm);
  color: var(--accent-strong);
}
</style>
