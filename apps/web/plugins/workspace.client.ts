/**
 * Chooses the dataset before anything reads from one.
 *
 * A plugin rather than a hook in `app.vue`: a page's `onMounted` runs before
 * the shell's does, so a screen would otherwise query the personal database
 * for a moment and render an empty workspace. Awaiting here means every page
 * that mounts afterwards already has the right database open.
 */
import { restoreActiveWorkspace } from '~/database'

export default defineNuxtPlugin(async () => {
  try {
    await restoreActiveWorkspace()
  } catch {
    // No IndexedDB, or a database that will not open. The app has its own
    // handling for both; failing here would take the whole page down with it.
  }
})
