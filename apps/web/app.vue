<script setup lang="ts">
const { status } = useConnectivity()
const { loadPreviewPlan, isPreview, planId } = useFeatureAccess()
const { restore, isAuthenticated } = useAuth()
const { restoreLocale, t } = useI18n()
const encryption = useEncryption()
const sync = useSync()
const workspace = useWorkspace()

onMounted(async () => {
  await restoreLocale()
  await loadPreviewPlan()
  // A real entitlement replaces the local preview if a session is restored.
  await restore()
  // Establish the encryption state once, here: every screen that shows a cloud
  // feature depends on it, and none of them should have to ask.
  if (isAuthenticated.value) await encryption.refresh()
  // Which dataset is open was settled by the workspace plugin, before any page
  // mounted. What is left is the key for it, which sync needs before it can
  // push anything into a shared stream.
  if (isAuthenticated.value) {
    await workspace.refresh()
    await workspace.loadKey()
  }
  sync.start()
})
</script>

<template>
  <div class="app">
    <header class="app__header">
      <NuxtLink to="/" class="app__brand">
        <img src="/icons/icon.svg" alt="" width="28" height="28" />
        <span>{{ t('common.appName') }}</span>
      </NuxtLink>

      <div class="app__meta">
        <WorkspaceSwitcher />
        <NuxtLink v-if="sync.conflicts.value > 0" to="/conflicts" class="badge badge--warn">
          {{ sync.conflicts.value }}
        </NuxtLink>
        <NuxtLink v-if="isPreview" to="/settings" class="badge badge--warn">
          {{ planId }}
        </NuxtLink>
        <span class="app__status" :data-state="status">
          <span class="app__dot" aria-hidden="true"></span>
          {{ status === 'online' ? t('common.online') : t('common.offline') }}
        </span>
      </div>
    </header>

    <AppNav class="app__nav-desktop" />

    <PwaUpdatePrompt />

    <main class="app__main">
      <NuxtPage />
    </main>

    <AppNav class="app__nav-mobile" />
  </div>
</template>

<style scoped>
.app {
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  background: var(--page);
}

.app__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border);
  position: sticky;
  top: 0;
  /*
   * Above the page, not merely stuck to the top of it. The header owns the
   * workspace menu, which opens *over* the content — with a lower stacking
   * order the menu paints behind `main` and only its first few pixels can be
   * clicked, which is exactly how it behaved before this line.
   */
  z-index: 30;
  background: color-mix(in srgb, var(--surface) 88%, transparent);
  backdrop-filter: blur(12px);
}

.app__brand {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-weight: 650;
  font-size: 1.0625rem;
  letter-spacing: -0.01em;
  color: inherit;
  text-decoration: none;
}

.app__brand img {
  border-radius: 7px;
}

.app__meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.app__status {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.8125rem;
  color: var(--text-muted);
}

.app__dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--ok);
}

.app__status[data-state='offline'] .app__dot {
  background: var(--warn);
}

.app__main {
  flex: 1;
  width: 100%;
  max-width: 56rem;
  margin: 0 auto;
  padding: var(--space-5) var(--space-4) calc(var(--space-6) + var(--safe-bottom));
}

.app__nav-desktop {
  display: none;
}

@media (min-width: 48rem) {
  .app__nav-desktop {
    display: flex;
  }

  .app__nav-mobile {
    display: none;
  }

  .app__main {
    padding-block: var(--space-6);
  }
}
</style>
