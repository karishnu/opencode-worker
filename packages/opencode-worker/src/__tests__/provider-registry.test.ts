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
    it("throws if anthropic key is missing", () => {
      const env = makeEnv()
      expect(() => getLanguageModel("anthropic", "claude-sonnet-4-20250514", env)).toThrow(
        "ANTHROPIC_API_KEY",
      )
    })

    it("returns a model for anthropic when key is set", () => {
      const env = makeEnv({ ANTHROPIC_API_KEY: "sk-test" })
      const model = getLanguageModel("anthropic", "claude-sonnet-4-20250514", env)
      expect(model).toBeDefined()
      expect(model.modelId).toBe("claude-sonnet-4-20250514")
    })

    it("throws if openai key is missing", () => {
      const env = makeEnv()
      expect(() => getLanguageModel("openai", "gpt-4o", env)).toThrow(
        "OPENAI_API_KEY",
      )
    })

    it("returns a model for openai when key is set", () => {
      const env = makeEnv({ OPENAI_API_KEY: "sk-test" })
      const model = getLanguageModel("openai", "gpt-4o", env)
      expect(model).toBeDefined()
      expect(model.modelId).toBe("gpt-4o")
    })

    it("throws for unknown provider", () => {
      const env = makeEnv()
      expect(() => getLanguageModel("unknown", "model", env)).toThrow(
        "Unknown provider",
      )
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

    it("marks all unconfigured when no keys set", () => {
      const env = makeEnv()
      const providers = listProviders(env)
      expect(providers).toHaveLength(3)
      expect(providers.every((p) => !p.configured)).toBe(true)
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
