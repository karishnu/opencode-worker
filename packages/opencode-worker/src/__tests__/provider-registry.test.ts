import { describe, it, expect } from "vitest"
import { getLanguageModel, listProviders } from "../provider/registry"
import type { Env } from "../env"

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    SESSION_DO: {} as any,
    SPACE_DO: {} as any,
    LOADER: {} as any,
    ...overrides,
  }
}

describe("provider/registry", () => {
  describe("getLanguageModel", () => {
    it("throws if no key and no AI binding", async () => {
      const env = makeEnv()
      await expect(getLanguageModel("anthropic", "claude-sonnet-4-20250514", env)).rejects.toThrow(
        "not configured",
      )
    })

    it("returns a model for anthropic when key is set", async () => {
      const env = makeEnv({ ANTHROPIC_API_KEY: "sk-test" })
      const model = await getLanguageModel("anthropic", "claude-sonnet-4-20250514", env)
      expect(model).toBeDefined()
      expect(model.modelId).toBe("claude-sonnet-4-20250514")
    })

    it("throws if openai key is missing and no AI binding", async () => {
      const env = makeEnv()
      await expect(getLanguageModel("openai", "gpt-4o", env)).rejects.toThrow(
        "not configured",
      )
    })

    it("returns a model for openai when key is set", async () => {
      const env = makeEnv({ OPENAI_API_KEY: "sk-test" })
      const model = await getLanguageModel("openai", "gpt-4o", env)
      expect(model).toBeDefined()
      expect(model.modelId).toBe("gpt-4o")
    })

    it("throws for unknown provider", async () => {
      const env = makeEnv()
      await expect(getLanguageModel("unknown", "model", env)).rejects.toThrow(
        "not configured",
      )
    })

    it("uses AI binding when no direct key is set", async () => {
      const mockGetUrl = async (provider?: string) => `https://gateway.ai.cloudflare.com/v1/acc/default/${provider}`
      const env = makeEnv({
        AI: { gateway: () => ({ getUrl: mockGetUrl }) } as any,
      })
      const model = await getLanguageModel("anthropic", "claude-sonnet-4-20250514", env)
      expect(model).toBeDefined()
      expect(model.modelId).toBe("claude-sonnet-4-20250514")
    })

    it("direct key takes priority over AI binding", async () => {
      const mockGetUrl = async () => "https://gateway.ai.cloudflare.com/v1/acc/default/anthropic"
      const env = makeEnv({
        ANTHROPIC_API_KEY: "sk-direct",
        AI: { gateway: () => ({ getUrl: mockGetUrl }) } as any,
      })
      const model = await getLanguageModel("anthropic", "claude-sonnet-4-20250514", env)
      expect(model).toBeDefined()
      expect(model.modelId).toBe("claude-sonnet-4-20250514")
    })
  })

  describe("listProviders", () => {
    it("marks configured providers correctly", () => {
      const env = makeEnv({ ANTHROPIC_API_KEY: "sk-test" })
      const providers = listProviders(env)
      expect(providers).toHaveLength(3)
      expect(providers.find((p) => p.id === "anthropic")?.configured).toBe(true)
      expect(providers.find((p) => p.id === "openai")?.configured).toBe(false)
      expect(providers.find((p) => p.id === "google")?.configured).toBe(false)
    })

    it("marks all unconfigured when no keys set and no AI binding", () => {
      const env = makeEnv()
      const providers = listProviders(env)
      expect(providers).toHaveLength(3)
      expect(providers.every((p) => !p.configured)).toBe(true)
    })

    it("marks all configured when AI binding is present", () => {
      const env = makeEnv({ AI: {} as any })
      const providers = listProviders(env)
      expect(providers).toHaveLength(3)
      expect(providers.every((p) => p.configured)).toBe(true)
    })

    it("marks all configured when gateway creds are set", () => {
      const env = makeEnv({
        CLOUDFLARE_ACCOUNT_ID: "abc123",
        CLOUDFLARE_GATEWAY_ID: "my-gw",
        CLOUDFLARE_API_TOKEN: "token",
      })
      const providers = listProviders(env)
      expect(providers).toHaveLength(3)
      expect(providers.every((p) => p.configured)).toBe(true)
    })

    it("accepts CF_AIG_TOKEN as alias for CLOUDFLARE_API_TOKEN", () => {
      const env = makeEnv({
        CLOUDFLARE_ACCOUNT_ID: "abc123",
        CLOUDFLARE_GATEWAY_ID: "my-gw",
        CF_AIG_TOKEN: "token",
      })
      const providers = listProviders(env)
      expect(providers.every((p) => p.configured)).toBe(true)
    })
  })
})
