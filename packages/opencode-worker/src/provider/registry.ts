import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createAiGateway } from "ai-gateway-provider"
import { createAnthropic as createAigAnthropic } from "ai-gateway-provider/providers/anthropic"
import { createOpenAI as createAigOpenAI } from "ai-gateway-provider/providers/openai"
import { createGoogleGenerativeAI as createAigGoogle } from "ai-gateway-provider/providers/google"
import type { LanguageModelV3 } from "@ai-sdk/provider"
import type { Env } from "../env"

/**
 * Resolve the AI Gateway API token, matching upstream precedence:
 * CLOUDFLARE_API_TOKEN ?? CF_AIG_TOKEN
 */
function gatewayToken(env: Env): string | undefined {
  return env.CLOUDFLARE_API_TOKEN || env.CF_AIG_TOKEN
}

/**
 * True when all three gateway env vars are present.
 */
function hasGateway(env: Env): boolean {
  return !!(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_GATEWAY_ID && gatewayToken(env))
}

/**
 * Build a LanguageModelV3 instance from provider + model IDs.
 *
 * When Cloudflare AI Gateway credentials are set, requests are
 * transparently routed through the gateway (observability, caching,
 * rate-limiting) — no separate provider needed. Provider API keys
 * are optional in gateway mode (BYOK / stored keys handle auth).
 *
 * Without gateway creds, each provider requires its own API key.
 */
export function getLanguageModel(
  providerId: string,
  modelId: string,
  env: Env,
): LanguageModelV3 {
  // ── Gateway-routed path ─────────────────────────────────────────
  if (hasGateway(env)) {
    const gw = createAiGateway({
      accountId: env.CLOUDFLARE_ACCOUNT_ID!,
      gateway: env.CLOUDFLARE_GATEWAY_ID!,
      apiKey: gatewayToken(env)!,
    })

    switch (providerId) {
      case "anthropic": {
        const sdk = createAigAnthropic({
          ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
        })
        return gw(sdk(modelId)) as unknown as LanguageModelV3
      }
      case "openai": {
        const sdk = createAigOpenAI({
          ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {}),
        })
        return gw(sdk.chat(modelId)) as unknown as LanguageModelV3
      }
      case "google": {
        const sdk = createAigGoogle({
          ...(env.GOOGLE_API_KEY ? { apiKey: env.GOOGLE_API_KEY } : {}),
        })
        return gw(sdk(modelId)) as unknown as LanguageModelV3
      }
      default:
        throw new Error(`Unknown provider: ${providerId}`)
    }
  }

  // ── Direct path (no gateway) ────────────────────────────────────
  switch (providerId) {
    case "anthropic": {
      const apiKey = env.ANTHROPIC_API_KEY
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured")
      return createAnthropic({ apiKey })(modelId)
    }
    case "openai": {
      const apiKey = env.OPENAI_API_KEY
      if (!apiKey) throw new Error("OPENAI_API_KEY not configured")
      return createOpenAI({ apiKey })(modelId)
    }
    case "google": {
      const apiKey = env.GOOGLE_API_KEY
      if (!apiKey) throw new Error("GOOGLE_API_KEY not configured")
      return createGoogleGenerativeAI({ apiKey })(modelId)
    }
    default:
      throw new Error(`Unknown provider: ${providerId}`)
  }
}

/**
 * List available providers based on which env keys are set.
 *
 * When AI Gateway is configured, all providers are marked as
 * configured — the gateway handles auth via stored keys (BYOK).
 */
export function listProviders(env: Env): Array<{ id: string; name: string; configured: boolean }> {
  const gw = hasGateway(env)
  return [
    { id: "anthropic", name: "Anthropic", configured: gw || !!env.ANTHROPIC_API_KEY },
    { id: "openai", name: "OpenAI", configured: gw || !!env.OPENAI_API_KEY },
    { id: "google", name: "Google", configured: gw || !!env.GOOGLE_API_KEY },
  ]
}
