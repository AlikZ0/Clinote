<script setup lang="ts">
/**
 * Export and import (product spec §29, §30).
 *
 * Available on every plan. Nothing here talks to a server: the archive is built
 * in the browser and handed to the user.
 */
import type { ImportMode, ImportOutcome, ImportPreview } from '~/services'
import { downloadBlob } from '~/utils/download'
import { formatBytes, formatDateTime } from '~/utils/format'

const { lastExportAt, ageDays, refresh: refreshLastExport } = useLastExport()
const { t } = useI18n()

const exporting = ref(false)
const exportError = ref<string | null>(null)
const exportedName = ref<string | null>(null)

const selected = ref<File | null>(null)
const preview = ref<ImportPreview | null>(null)
const mode = ref<ImportMode>('merge')
const confirmingReplace = ref(false)
const importing = ref(false)
const importError = ref<string | null>(null)
const outcome = ref<ImportOutcome | null>(null)

onMounted(refreshLastExport)

async function runExport(): Promise<void> {
  exporting.value = true
  exportError.value = null
  exportedName.value = null
  try {
    const services = await useServices()
    const result = await services.exports.createArchive()
    downloadBlob(result.blob, result.filename)
    exportedName.value = `${result.filename} · ${formatBytes(result.sizeBytes)}`
    await refreshLastExport()
  } catch (error) {
    exportError.value = describeError(error)
  } finally {
    exporting.value = false
  }
}

async function onFileSelected(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0] ?? null
  input.value = ''
  reset()
  if (!file) return

  selected.value = file
  try {
    const services = await useServices()
    preview.value = await services.imports.inspect(file)
  } catch (error) {
    importError.value = describeError(error)
    selected.value = null
  }
}

async function runImport(): Promise<void> {
  if (!selected.value || importing.value) return
  importing.value = true
  importError.value = null

  try {
    const services = await useServices()
    const result = await services.imports.apply(selected.value, mode.value)
    outcome.value = result
    // The safety copy only helps if the user actually has it.
    if (result.safetyCopy) downloadBlob(result.safetyCopy.blob, result.safetyCopy.filename)
    selected.value = null
    preview.value = null
    confirmingReplace.value = false
    await refreshLastExport()
  } catch (error) {
    importError.value = describeError(error)
  } finally {
    importing.value = false
  }
}

function reset(): void {
  selected.value = null
  preview.value = null
  outcome.value = null
  importError.value = null
  confirmingReplace.value = false
}

const totals = computed(() => {
  if (!outcome.value) return null
  const all = Object.values(outcome.value.tallies)
  return {
    inserted: all.reduce((sum, tally) => sum + tally.inserted, 0),
    updated: all.reduce((sum, tally) => sum + tally.updated, 0),
    skipped: all.reduce((sum, tally) => sum + tally.skipped, 0),
  }
})
</script>

<template>
  <section class="stack">
    <h1>{{ t('backup.title') }}</h1>

    <CloudBackupCard />

    <div class="card stack stack--tight">
      <h2>{{ t('backup.exportTitle') }}</h2>
      <p class="hint">{{ t('backup.exportDescription') }}</p>

      <p v-if="lastExportAt" class="hint">
        {{ t('dashboard.lastExport', { date: formatDateTime(lastExportAt) }) }}
        <template v-if="ageDays !== null">
          {{ t('dashboard.lastExportAge', { days: ageDays }) }}
        </template>
      </p>
      <p v-else class="hint warn">{{ t('dashboard.neverExported') }}</p>

      <button type="button" class="button button--primary" :disabled="exporting" @click="runExport">
        {{ exporting ? t('backup.exporting') : t('backup.exportAction') }}
      </button>

      <p v-if="exportedName" class="hint">{{ t('backup.exportSaved', { name: exportedName }) }}</p>
      <p v-if="exportError" class="alert" role="alert">{{ exportError }}</p>
    </div>

    <div class="card stack stack--tight">
      <h2>{{ t('backup.importTitle') }}</h2>
      <p class="hint">{{ t('backup.importDescription') }}</p>

      <label class="button">
        {{ t('backup.chooseFile') }}
        <input
          class="visually-hidden"
          type="file"
          accept=".zip,application/zip"
          @change="onFileSelected"
        />
      </label>

      <p v-if="importError" class="alert" role="alert">{{ importError }}</p>

      <template v-if="preview">
        <dl class="details">
          <dt>{{ t('backup.created') }}</dt>
          <dd>{{ formatDateTime(preview.createdAt) }}</dd>
          <dt>{{ t('dashboard.clients') }}</dt>
          <dd>{{ preview.counts.clients }}</dd>
          <dt>{{ t('dashboard.works') }}</dt>
          <dd>{{ preview.counts.works }}</dd>
          <dt>{{ t('dashboard.files') }}</dt>
          <dd>{{ preview.counts.files }}</dd>
          <dt>{{ t('dashboard.appointments') }}</dt>
          <dd>{{ preview.counts.appointments }}</dd>
          <dt>{{ t('backup.version') }}</dt>
          <dd>{{ preview.appVersion }}</dd>
        </dl>

        <fieldset class="modes">
          <legend class="visually-hidden">{{ t('backup.mode') }}</legend>
          <label class="mode">
            <input v-model="mode" type="radio" value="merge" />
            <span>
              <strong>{{ t('backup.merge') }}</strong>
              <br />
              <span class="hint">{{ t('backup.mergeDescription') }}</span>
            </span>
          </label>
          <label class="mode">
            <input v-model="mode" type="radio" value="replace" />
            <span>
              <strong>{{ t('backup.replace') }}</strong>
              <br />
              <span class="hint">{{ t('backup.replaceDescription') }}</span>
            </span>
          </label>
        </fieldset>

        <template v-if="mode === 'replace' && !confirmingReplace">
          <button type="button" class="button button--danger" @click="confirmingReplace = true">
            {{ t('backup.replaceAction') }}
          </button>
        </template>
        <template v-else-if="mode === 'replace'">
          <p class="hint warn">
            This removes the clients, works and files currently on this device. A copy of them will
            be saved to your downloads first.
          </p>
          <div class="row">
            <button type="button" class="button" @click="confirmingReplace = false">Cancel</button>
            <button
              type="button"
              class="button button--danger"
              :disabled="importing"
              @click="runImport"
            >
              {{ importing ? 'Importing…' : 'Yes, replace' }}
            </button>
          </div>
        </template>
        <button
          v-else
          type="button"
          class="button button--primary"
          :disabled="importing"
          @click="runImport"
        >
          {{ importing ? t('backup.importing') : t('backup.mergeAction') }}
        </button>
      </template>

      <template v-if="outcome && totals">
        <p class="hint">
          {{
            t('backup.importResult', {
              added: totals.inserted,
              updated: totals.updated,
              skipped: totals.skipped,
            })
          }}
        </p>
        <p v-if="outcome.safetyCopy" class="hint">
          {{ t('backup.safetyCopy', { name: outcome.safetyCopy.filename }) }}
        </p>
      </template>
    </div>
  </section>
</template>

<style scoped>
.details {
  display: grid;
  grid-template-columns: minmax(9rem, auto) 1fr;
  gap: 0.25rem 1rem;
  margin: 0;
}

.details dt {
  color: var(--text-muted);
}

.details dd {
  margin: 0;
}

.modes {
  border: 0;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 0.5rem;
}

.mode {
  display: flex;
  align-items: flex-start;
  gap: 0.625rem;
  padding: 0.625rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  cursor: pointer;
}

.mode input {
  margin-top: 0.25rem;
  min-width: 1.125rem;
  min-height: 1.125rem;
}
</style>
