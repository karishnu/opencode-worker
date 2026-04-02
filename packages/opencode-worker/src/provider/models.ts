import type { ProviderModel } from "../upstream-types"

/**
 * Static model catalog for all providers.
 *
 * Used by the /config/providers and /provider routes to tell
 * the client which models are available for selection.
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
