/**
 * Paged client list (product spec §66).
 *
 * Pages are loaded through the index cursor, so the screen never holds the
 * whole table and the query cost does not grow with the number of clients.
 */
import type { Client } from '@clinote/types'

export const CLIENT_PAGE_SIZE = 30

export function useClientList() {
  const items = ref<Client[]>([])
  const query = ref('')
  const loading = ref(false)
  const hasMore = ref(false)
  const errorMessage = ref<string | null>(null)
  const cursor = ref<string | null>(null)

  async function load(reset: boolean): Promise<void> {
    if (loading.value) return
    loading.value = true
    errorMessage.value = null

    try {
      const services = await useServices()

      if (query.value.trim()) {
        // Search is a bounded prefix lookup, not a paged list.
        items.value = await services.clients.search(query.value, CLIENT_PAGE_SIZE)
        hasMore.value = false
        cursor.value = null
        return
      }

      const page = await services.clients.list({
        cursor: reset ? null : cursor.value,
        limit: CLIENT_PAGE_SIZE,
      })
      items.value = reset ? page.items : [...items.value, ...page.items]
      cursor.value = page.nextCursor
      hasMore.value = page.hasMore
    } catch (error) {
      errorMessage.value = describeError(error)
    } finally {
      loading.value = false
    }
  }

  let searchTimer: ReturnType<typeof setTimeout> | undefined
  watch(query, () => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => void load(true), 200)
  })

  return {
    items,
    query,
    loading,
    hasMore,
    errorMessage,
    refresh: () => load(true),
    loadMore: () => load(false),
  }
}
