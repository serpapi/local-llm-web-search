import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { runAgentTurn } from "../agent.server"
import { searchesIn } from "../chat-session.server"

// Tests run a whole agent turn with SerpApi and LM Studio mocked: no
// search is spent and no model is loaded or unloaded.

const getJson = vi.hoisted(() => vi.fn())
const createCompletion = vi.hoisted(() => vi.fn())

vi.mock("serpapi", () => ({
  config: {},
  getJson,
  InvalidArgumentError: class extends Error {},
  MissingApiKeyError: class extends Error {},
}))

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: createCompletion } }
  },
}))

const toolCall = (id: string, name: string, query: string) => ({
  id,
  type: "function",
  function: { name, arguments: JSON.stringify({ query }) },
})

beforeEach(() => {
  vi.stubEnv("SERPAPI_API_KEY", "test-key")
  // WHY: a finished turn arms the idle-unload timer, which calls LM Studio.
  //      Fake timers keep it from firing, and fetch fails if anything slips.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
  vi.stubGlobal("fetch", () => Promise.reject(new Error("No network in tests")))
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

describe("runAgentTurn", () => {
  it("records the searches a round spent before another call failed", async () => {
    createCompletion.mockResolvedValue({
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              toolCall("1", "google_finance_search", "Acme"),
              toolCall("2", "google_search", "weather"),
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })
    // No Finance quote for Acme, so that call falls back to google_search
    // and spends two searches. The weather search fails.
    getJson.mockImplementation((params: Record<string, unknown>) => {
      if (params.engine === "google_finance") return Promise.resolve({})
      if (params.q === "Acme") {
        return Promise.resolve({ organic_results: [{ title: "Acme Corp" }] })
      }
      return Promise.reject(new Error("Invalid API key."))
    })

    const result = await runAgentTurn({
      question: "Acme stock and the weather?",
      model: "test-model",
      history: [],
      toolOutput: "json",
    })

    expect(result.ok).toBe(false)
    expect(result.answer).toMatch(/Invalid API key/)
    expect(result.toolCalls.map((c) => [c.name, c.searches])).toEqual([
      ["google_finance_search", 2],
    ])
    expect(searchesIn(result.toolCalls)).toBe(2)
  })
})
