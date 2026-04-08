import type { ProviderModel } from "../upstream-types"

const MODELS_DEV_URL = "https://models.dev/api.json"
const CACHE_TTL = 60 * 60 * 1000 // 1 hour

let cached: Record<string, ProviderModel[]> | undefined
let cachedAt = 0

/**
 * Supported provider IDs we can actually route requests to.
 */
const SUPPORTED = new Set(["anthropic", "openai", "google"])

/**
 * Fetch models from models.dev and parse into ProviderModel shape.
 * Returns undefined on failure.
 */
async function fetchModels(): Promise<Record<string, ProviderModel[]> | undefined> {
  try {
    const res = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(5000) })
    if (!res.ok) return undefined
    const data = await res.json() as Record<string, {
      id: string
      name: string
      models: Record<string, {
        id: string
        name: string
        reasoning?: boolean
        attachment?: boolean
        cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
        limit: { context: number; output: number }
        modalities?: { input?: string[]; output?: string[] }
      }>
    }>
    const result: Record<string, ProviderModel[]> = {}
    for (const [pid, provider] of Object.entries(data)) {
      if (!SUPPORTED.has(pid)) continue
      result[pid] = Object.values(provider.models).map((m) => ({
        id: m.id,
        name: m.name,
        provider: pid,
        context_length: m.limit.context,
        reasoning: m.reasoning,
        attachment: m.attachment,
        cost: m.cost ? {
          input: m.cost.input ?? 0,
          output: m.cost.output ?? 0,
          cache_read: m.cost.cache_read,
          cache_write: m.cost.cache_write,
        } : undefined,
      }))
    }
    return result
  } catch {
    return undefined
  }
}

/**
 * Get models for a provider. Tries cached models.dev data first,
 * falls back to static PROVIDER_MODELS.
 */
export async function getModels(providerId: string): Promise<Record<string, ProviderModel>> {
  if (!cached || Date.now() - cachedAt > CACHE_TTL) {
    const fresh = await fetchModels()
    if (fresh) {
      cached = fresh
      cachedAt = Date.now()
    }
  }
  const list = cached?.[providerId] ?? PROVIDER_MODELS[providerId] ?? []
  const models: Record<string, ProviderModel> = {}
  for (const m of list) models[m.id] = m
  return models
}

/**
 * Static model catalog for all providers.
 *
 * Used as fallback when models.dev fetch fails.
 * Also used by the /config/providers and /provider routes.
 */
export const PROVIDER_MODELS: Record<string, ProviderModel[]> = {
  anthropic: [
    {
      id: "claude-sonnet-4-20250514",
      name: "Claude Sonnet 4",
      provider: "anthropic",
      context_length: 200000,
      reasoning: true,
      cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
    },
    {
      id: "claude-opus-4-20250514",
      name: "Claude Opus 4",
      provider: "anthropic",
      context_length: 200000,
      reasoning: true,
      cost: { input: 15, output: 75, cache_read: 1.5, cache_write: 18.75 },
    },
    {
      id: "claude-3-5-haiku-20241022",
      name: "Claude 3.5 Haiku",
      provider: "anthropic",
      context_length: 200000,
      cost: { input: 0.8, output: 4, cache_read: 0.08, cache_write: 1 },
    },
  ],
  openai: [
    {
      id: "gpt-4o",
      name: "GPT-4o",
      provider: "openai",
      context_length: 128000,
      cost: { input: 2.5, output: 10 },
    },
    {
      id: "gpt-4o-mini",
      name: "GPT-4o Mini",
      provider: "openai",
      context_length: 128000,
      cost: { input: 0.15, output: 0.6 },
    },
    {
      id: "o3",
      name: "o3",
      provider: "openai",
      context_length: 200000,
      reasoning: true,
      cost: { input: 2, output: 8 },
    },
  ],
  google: [
    {
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      provider: "google",
      context_length: 1048576,
      reasoning: true,
      cost: { input: 1.25, output: 10 },
    },
    {
      id: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      provider: "google",
      context_length: 1048576,
      reasoning: true,
      cost: { input: 0.15, output: 0.6 },
    },
  ],
}

export function buildModels(providerId: string): Record<string, ProviderModel> {
  const models: Record<string, ProviderModel> = {}
  const catalog = PROVIDER_MODELS[providerId] ?? []
  for (const m of catalog) {
    models[m.id] = m
  }
  return models
}

/**
 * Reset the models.dev cache (for testing).
 */
export function resetModelsCache() {
  cached = undefined
  cachedAt = 0
}
