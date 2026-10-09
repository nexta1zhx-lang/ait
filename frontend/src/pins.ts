import {ref} from 'vue'
import {fetchPins, togglePin} from './api'

export const pinnedBases = ref<string[]>([])
export const maxPinnedBases = ref(5)

const PINS_FRESH_MS = 20_000
let loadedAt = 0
let loadInFlight: Promise<void> | null = null
let revision = 0

export async function ensurePins(): Promise<void> {
  if (Date.now() - loadedAt < PINS_FRESH_MS) return
  if (loadInFlight) return loadInFlight

  const requestRevision = revision
  const request = fetchPins().then(result => {
    if (revision !== requestRevision) return
    pinnedBases.value = result.pins
    maxPinnedBases.value = result.max
    loadedAt = Date.now()
  })
  loadInFlight = request
  try {
    await request
  } finally {
    if (loadInFlight === request) loadInFlight = null
  }
}

export async function toggleFavorite(base: string): Promise<void> {
  const result = await togglePin(base)
  revision++
  pinnedBases.value = result.pins
  maxPinnedBases.value = result.max
  loadedAt = Date.now()
}

export function isPinnedBase(base: string): boolean {
  return pinnedBases.value.includes(base.toUpperCase())
}
