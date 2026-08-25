<script setup lang="ts">
/**
 * Conflicts that need a person (docs/sync.md §5).
 *
 * Nothing was thrown away to get here: both versions are shown, and the choice
 * is published so the other device ends up with the decision.
 */
import type { ConflictChoice, ConflictView } from '~/services/conflictService'
import { ConflictService } from '~/services/conflictService'
import { getLocalCore } from '~/database'
import { formatDateTime } from '~/utils/format'

const { t } = useI18n()
const conflicts = ref<ConflictView[]>([])
const loading = ref(true)
const errorMessage = ref<string | null>(null)
const sync = useSync()

async function load(): Promise<void> {
  loading.value = true
  try {
    conflicts.value = await new ConflictService(await getLocalCore()).list()
  } catch (error) {
    errorMessage.value = describeError(error)
  } finally {
    loading.value = false
  }
}

async function resolve(id: string, choice: ConflictChoice): Promise<void> {
  try {
    await new ConflictService(await getLocalCore()).resolve(id, choice)
    await load()
    await sync.refreshStatus()
    void sync.syncNow()
  } catch (error) {
    errorMessage.value = describeError(error)
  }
}

function label(field: string): string {
  switch (field) {
    case 'startAt':
      return t('conflicts.fieldStartAt')
    case 'endAt':
      return t('conflicts.fieldEndAt')
    case 'description':
      return t('conflicts.fieldDescription')
    default:
      return t('conflicts.fieldNotes')
  }
}

/** "Keep both" only makes sense for text; there is no both for a time. */
function canKeepBoth(conflict: ConflictView): boolean {
  return conflict.differences.every((difference) => !difference.field.endsWith('At'))
}

onMounted(load)
</script>

<template>
  <section class="stack">
    <h1>{{ t('conflicts.title') }}</h1>

    <p v-if="errorMessage" class="alert" role="alert">{{ errorMessage }}</p>

    <p v-if="!loading && conflicts.length === 0" class="empty">{{ t('conflicts.empty') }}</p>

    <article v-for="conflict in conflicts" :key="conflict.id" class="card stack stack--tight">
      <div class="row">
        <h2>{{ conflict.title }}</h2>
        <span class="badge">{{ formatDateTime(conflict.detectedAt) }}</span>
      </div>

      <p class="hint">{{ t('conflicts.explanation') }}</p>

      <div v-for="difference in conflict.differences" :key="difference.field" class="diff">
        <h3>{{ label(difference.field) }}</h3>
        <div class="diff__sides">
          <div class="diff__side">
            <span class="diff__label">{{ t('conflicts.thisDevice') }}</span>
            <p>{{ difference.mine || '—' }}</p>
          </div>
          <div class="diff__side">
            <span class="diff__label">{{ t('conflicts.otherDevice') }}</span>
            <p>{{ difference.theirs || '—' }}</p>
          </div>
        </div>
      </div>

      <div class="row wrap">
        <button type="button" class="button" @click="resolve(conflict.id, 'mine')">
          {{ t('conflicts.keepMine') }}
        </button>
        <button type="button" class="button" @click="resolve(conflict.id, 'theirs')">
          {{ t('conflicts.keepTheirs') }}
        </button>
        <button
          v-if="canKeepBoth(conflict)"
          type="button"
          class="button button--primary"
          @click="resolve(conflict.id, 'both')"
        >
          {{ t('conflicts.keepBoth') }}
        </button>
      </div>
    </article>
  </section>
</template>

<style scoped>
.diff {
  border-top: 1px solid var(--border);
  padding-top: 0.625rem;
}

.diff h3 {
  margin: 0 0 0.375rem;
  font-size: 0.8125rem;
  color: var(--text-muted);
}

.diff__sides {
  display: grid;
  gap: 0.5rem;
}

@media (min-width: 40rem) {
  .diff__sides {
    grid-template-columns: 1fr 1fr;
  }
}

.diff__side {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.5rem 0.75rem;
  background: var(--surface);
}

.diff__label {
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.diff__side p {
  margin: 0.25rem 0 0;
  white-space: pre-wrap;
}

.actions {
  flex-wrap: wrap;
  justify-content: flex-start;
}
</style>
