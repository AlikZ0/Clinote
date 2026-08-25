<script setup lang="ts">
/**
 * Bottom bar on a phone, a row of pills on a desk (product spec §55).
 *
 * Locked paid entries stay visible rather than disappearing: a Free user should
 * be able to find out what Calendar is (§56).
 */
import type { MessageKey } from '~/composables/useI18n'

const { t } = useI18n()
const workspace = useWorkspace()

/**
 * Team only appears once it means something — a workspace is open, or the plan
 * includes them. A solo practitioner has no team to look at.
 */
interface NavLink {
  to: string
  key: MessageKey
  icon: string
}

const team: NavLink[] = [{ to: '/team', key: 'nav.team', icon: '👤' }]

const links = computed<NavLink[]>(() => [
  { to: '/', key: 'nav.home', icon: '🏠' },
  { to: '/clients', key: 'nav.clients', icon: '👥' },
  { to: '/calendar', key: 'nav.calendar', icon: '📅' },
  ...(workspace.activeId.value || workspace.available.value ? team : []),
  { to: '/backup', key: 'nav.backup', icon: '💾' },
  { to: '/settings', key: 'nav.more', icon: '⚙️' },
])
</script>

<template>
  <nav class="nav" :aria-label="t('nav.home')">
    <NuxtLink v-for="link in links" :key="link.to" :to="link.to" class="nav__link">
      <span class="nav__icon" aria-hidden="true">{{ link.icon }}</span>
      <span class="nav__label">{{ t(link.key) }}</span>
    </NuxtLink>
  </nav>
</template>

<style scoped>
.nav {
  display: flex;
  border-top: 1px solid var(--border);
  background: color-mix(in srgb, var(--surface) 92%, transparent);
  backdrop-filter: blur(12px);
  position: sticky;
  bottom: 0;
  /* Above the page, below the header and its menu. */
  z-index: 20;
  padding-bottom: var(--safe-bottom);
}

.nav__link {
  flex: 1;
  min-height: 58px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.15rem;
  font-size: 0.6875rem;
  font-weight: 550;
  color: var(--text-muted);
  text-decoration: none;
}

.nav__icon {
  font-size: 1.15rem;
  line-height: 1;
}

.nav__link.router-link-active {
  color: var(--accent-strong);
}

@media (min-width: 48rem) {
  .nav {
    position: static;
    border-top: none;
    border-bottom: 1px solid var(--border);
    padding: var(--space-2) var(--space-4);
    gap: var(--space-1);
    justify-content: flex-start;
    background: transparent;
    backdrop-filter: none;
  }

  .nav__link {
    flex: 0 0 auto;
    flex-direction: row;
    gap: var(--space-2);
    min-height: 40px;
    padding: 0 0.9rem;
    border-radius: var(--radius-pill);
    font-size: 0.875rem;
  }

  .nav__link:hover {
    background: var(--surface-sunken);
    color: var(--text);
  }

  .nav__link.router-link-active {
    background: var(--accent-soft);
    color: var(--accent-strong);
  }

  .nav__icon {
    font-size: 1rem;
  }
}
</style>
