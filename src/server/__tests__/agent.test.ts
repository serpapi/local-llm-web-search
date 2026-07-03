import { afterEach, describe, expect, it } from "vitest"

import {
  contextBackoffSequence,
  contextOverride,
  extractSources,
  isEmptyFinanceResponse,
  normalizeCountryCode,
  parseInlineToolCalls,
  recommendedContext,
  redactSecrets,
  sanitizeHistoryForReplay,
  stripInlineToolCalls,
  toolParams,
  trimHistoryToFit,
  validateToolArgs,
} from "../agent"

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"

// Tests cover the pure helpers around the SerpApi tool loop: history
// sanitisation, secret redaction, inline-XML tool-call parsing, sliding-
// window history trimming, country-code normalisation, tool-arg
// validation, per-engine request building, the empty-finance fallback
// signal, and sources extraction. SerpApi response shaping is handled
// server-side by `json_restrictor`, so there is no client-side formatter
// to test.

describe("sanitizeHistoryForReplay", () => {
  it("strips tool_call + tool messages and neutralizes the answer", () => {
    const history = [
      { role: "user" as const, content: "Flights from SCL to MAD" },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function" as const,
            function: {
              name: "google_flights_search",
              arguments: JSON.stringify({ departure_id: "SCL" }),
            },
          },
        ],
      },
      {
        role: "tool" as const,
        tool_call_id: "call_1",
        content: '{"table": "| LATAM | $635 |..."}',
      },
      {
        role: "assistant" as const,
        content: "Here are the flights... | LATAM | $635 |",
      },
    ]
    const out = sanitizeHistoryForReplay(history)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ role: "user", content: "Flights from SCL to MAD" })
    expect(out[1].role).toBe("assistant")
    expect(out[1].content).toMatch(/re-run the tool/i)
    // The replayable table must not survive.
    expect(JSON.stringify(out)).not.toContain("LATAM")
    expect(JSON.stringify(out)).not.toContain("$635")
  })

  it("preserves assistant messages that didn't come from a tool cycle", () => {
    const history = [
      { role: "user" as const, content: "What is 2+2?" },
      { role: "assistant" as const, content: "2+2 = 4." },
    ]
    const out = sanitizeHistoryForReplay(history)
    expect(out).toEqual(history)
  })

  it("handles multi-turn histories with mixed tool and non-tool turns", () => {
    const history = [
      { role: "user" as const, content: "Hi" },
      { role: "assistant" as const, content: "Hello!" },
      { role: "user" as const, content: "Price of NVDA?" },
      {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          {
            id: "c1",
            type: "function" as const,
            function: { name: "google_finance_search", arguments: "{}" },
          },
        ],
      },
      { role: "tool" as const, tool_call_id: "c1", content: "{}" },
      { role: "assistant" as const, content: "NVDA is $199." },
    ]
    const out = sanitizeHistoryForReplay(history)
    // user/greet/user/placeholder — tool_calls + tool messages dropped.
    expect(out).toHaveLength(4)
    expect(out[0]).toEqual({ role: "user", content: "Hi" })
    expect(out[1]).toEqual({ role: "assistant", content: "Hello!" })
    expect(out[2]).toEqual({ role: "user", content: "Price of NVDA?" })
    expect(out[3].content).toMatch(/re-run the tool/i)
    expect(JSON.stringify(out)).not.toContain("$199")
  })
})

describe("redactSecrets", () => {
  it("redacts sk- style API keys", () => {
    const input = "My key is sk-proj-AbCdEf1234567890xyz_-_thisIsLong"
    const out = redactSecrets(input)
    expect(out).toContain("[redacted-sk-key]")
    expect(out).not.toContain("sk-proj-AbCdEf")
  })

  it("redacts long hex strings (likely API tokens or hashes)", () => {
    const input =
      "token=deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    const out = redactSecrets(input)
    expect(out).toContain("[redacted-hex-key]")
    expect(out).not.toMatch(/[0-9a-f]{32,}/)
  })

  it("redacts email addresses", () => {
    const input = "Contact me at test.user+demo@example.co.uk for more info"
    const out = redactSecrets(input)
    expect(out).toContain("[redacted-email]")
    expect(out).not.toContain("test.user+demo@example.co.uk")
  })

  it("leaves clean text untouched", () => {
    const input = "What is the price of AAPL stock today?"
    expect(redactSecrets(input)).toBe(input)
  })
})

describe("parseInlineToolCalls", () => {
  it("returns an empty array when no tool_call blocks are present", () => {
    const out = parseInlineToolCalls("just a normal answer with no tool calls")
    expect(out).toEqual([])
  })

  it("parses a Qwen/Llama nested-XML tool call", () => {
    const content = `
      I'll look this up.
      <tool_call>
      <function=google_search>
      <parameter=query>F1 race winner</parameter>
      <parameter=num>3</parameter>
      </function>
      </tool_call>
    `
    const out = parseInlineToolCalls(content)
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe("google_search")
    expect(out[0].args).toEqual({ query: "F1 race winner", num: 3 })
  })

  it("parses multiple tool_call blocks (parallel calls)", () => {
    const content = `
      <tool_call>
      <function=google_finance_search>
      <parameter=query>NVDA</parameter>
      </function>
      </tool_call>
      <tool_call>
      <function=google_news_search>
      <parameter=query>AI regulation</parameter>
      </function>
      </tool_call>
    `
    const out = parseInlineToolCalls(content)
    expect(out).toHaveLength(2)
    expect(out[0].name).toBe("google_finance_search")
    expect(out[0].args).toEqual({ query: "NVDA" })
    expect(out[1].name).toBe("google_news_search")
    expect(out[1].args).toEqual({ query: "AI regulation" })
  })

  it("parses a JSON-shaped tool call (OpenAI-like)", () => {
    const content = `<tool_call>{"name":"google_maps_search","arguments":{"query":"barbecue in Austin"}}</tool_call>`
    const out = parseInlineToolCalls(content)
    expect(out).toHaveLength(1)
    expect(out[0].name).toBe("google_maps_search")
    expect(out[0].args).toEqual({ query: "barbecue in Austin" })
  })
})

describe("trimHistoryToFit", () => {
  it("returns the same history when no trimming is needed", () => {
    const history: Array<ChatCompletionMessageParam> = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ]
    const { trimmed, dropped } = trimHistoryToFit(history, 0, 100_000)
    expect(dropped).toBe(0)
    expect(trimmed).toEqual(history)
  })

  it("drops the oldest messages first when over budget", () => {
    const big = "lorem ipsum ".repeat(200)
    const history: Array<ChatCompletionMessageParam> = [
      { role: "user", content: `OLDEST: ${big}` },
      { role: "assistant", content: `MIDDLE: ${big}` },
      { role: "user", content: `NEWEST: ${big}` },
    ]
    const { trimmed, dropped } = trimHistoryToFit(history, 0, 600)
    expect(dropped).toBeGreaterThan(0)
    expect(trimmed.length).toBeLessThan(history.length)
    const surviving = JSON.stringify(trimmed)
    expect(surviving).toContain("NEWEST")
    expect(surviving).not.toContain("OLDEST")
  })

  it("is a no-op for empty history", () => {
    const { trimmed, dropped } = trimHistoryToFit([], 0, 100)
    expect(trimmed).toEqual([])
    expect(dropped).toBe(0)
  })
})

describe("normalizeCountryCode", () => {
  it("accepts valid ISO 3166-1 alpha-2 codes", () => {
    expect(normalizeCountryCode("us")).toBe("us")
    expect(normalizeCountryCode("GB")).toBe("gb")
    expect(normalizeCountryCode(" cl ")).toBe("cl")
  })

  it("rejects regional bloc codes that SerpApi refuses", () => {
    // Regression: 'eu' triggered "Unsupported eu country - gl parameter."
    expect(normalizeCountryCode("eu")).toBeUndefined()
    expect(normalizeCountryCode("EU")).toBeUndefined()
    expect(normalizeCountryCode("apac")).toBeUndefined()
    expect(normalizeCountryCode("latam")).toBeUndefined()
  })

  it("rejects malformed codes silently", () => {
    expect(normalizeCountryCode("usa")).toBeUndefined()
    expect(normalizeCountryCode("12")).toBeUndefined()
    expect(normalizeCountryCode("")).toBeUndefined()
    expect(normalizeCountryCode(undefined)).toBeUndefined()
  })
})

describe("contextBackoffSequence", () => {
  it("halves from the start down to the 4K floor, largest first", () => {
    expect(contextBackoffSequence(32768)).toEqual([32768, 16384, 8192, 4096])
  })

  it("stops before going below the 4K minimum", () => {
    // 12288 -> 6144 -> (3072 is below 4096, dropped)
    expect(contextBackoffSequence(12288)).toEqual([12288, 6144])
  })

  it("returns just the floor when start equals the minimum", () => {
    expect(contextBackoffSequence(4096)).toEqual([4096])
  })

  it("rounds the start down to a clean 1024 step", () => {
    // 33000 -> floor to 32768, then the usual halving
    expect(contextBackoffSequence(33000)).toEqual([32768, 16384, 8192, 4096])
  })

  it("returns an empty schedule when the start is below the minimum", () => {
    expect(contextBackoffSequence(2048)).toEqual([])
  })
})

describe("recommendedContext", () => {
  it("caps the optimistic start at 32K when the model allows more", () => {
    // Most modern models report a huge max (256K+); we start at the 32K cap.
    expect(recommendedContext(262144)).toBe(32768)
    expect(recommendedContext(131072)).toBe(32768)
  })

  it("never exceeds the model's native max", () => {
    expect(recommendedContext(8192)).toBe(8192)
    expect(recommendedContext(4096)).toBe(4096)
  })
})

describe("contextOverride", () => {
  afterEach(() => {
    delete process.env.LMSTUDIO_CONTEXT_LENGTH
  })

  it("returns null when the env var is unset", () => {
    delete process.env.LMSTUDIO_CONTEXT_LENGTH
    expect(contextOverride()).toBeNull()
  })

  it("reads a valid pin and floors it to a clean 1024 step", () => {
    process.env.LMSTUDIO_CONTEXT_LENGTH = "9000"
    expect(contextOverride()).toBe(8192) // 9000 -> floor to 8192
    process.env.LMSTUDIO_CONTEXT_LENGTH = "16384"
    expect(contextOverride()).toBe(16384)
  })

  it("ignores values below the 4K minimum or non-numeric junk", () => {
    process.env.LMSTUDIO_CONTEXT_LENGTH = "1000"
    expect(contextOverride()).toBeNull()
    process.env.LMSTUDIO_CONTEXT_LENGTH = "not-a-number"
    expect(contextOverride()).toBeNull()
  })
})

describe("validateToolArgs", () => {
  it("returns the parsed args for a valid call", () => {
    const args = validateToolArgs("google_search", {
      query: "latest nvidia news",
      num: 5,
      gl: "us",
    })
    expect(args).toEqual({ query: "latest nvidia news", num: 5, gl: "us" })
  })

  it("rejects a tool the server doesn't know about", () => {
    expect(() => validateToolArgs("google_shopping", {})).toThrow(
      /Unknown tool/
    )
  })

  it("rejects malformed args and names the offending field", () => {
    expect(() =>
      validateToolArgs("google_search", { query: "chips", num: "five" })
    ).toThrow(/num/)
  })

  it("rejects a flights date that isn't YYYY-MM-DD", () => {
    expect(() =>
      validateToolArgs("google_flights_search", {
        departure_id: "SCL",
        arrival_id: "MAD",
        outbound_date: "March 3rd",
      })
    ).toThrow(/outbound_date/)
  })

  it("requires both hotel dates", () => {
    expect(() =>
      validateToolArgs("google_hotels_search", {
        query: "hotels in Barcelona",
        check_in_date: "2026-08-01",
      })
    ).toThrow(/check_out_date/)
  })
})

describe("toolParams", () => {
  it("builds a google_search request with the 5-result default", () => {
    expect(toolParams("google_search", { query: "serpapi" })).toEqual({
      engine: "google",
      q: "serpapi",
      num: 5,
    })
  })

  it("keeps a clean country code and drops a regional bloc", () => {
    expect(
      toolParams("google_search", { query: "chips", gl: "US" })
    ).toMatchObject({ gl: "us" })
    // "eu" is rejected by SerpApi as `gl` — must become a no-op, not a 4xx.
    expect(
      toolParams("google_search", { query: "chips", gl: "eu" })
    ).not.toHaveProperty("gl")
  })

  it("builds a google_maps request with the fixed search type", () => {
    expect(
      toolParams("google_maps_search", { query: "coffee in Austin" })
    ).toEqual({ engine: "google_maps", q: "coffee in Austin", type: "search" })
  })

  it("defaults flights to one-way USD and omits absent options", () => {
    expect(
      toolParams("google_flights_search", {
        departure_id: "SCL",
        arrival_id: "MAD",
        outbound_date: "2026-08-01",
      })
    ).toEqual({
      engine: "google_flights",
      departure_id: "SCL",
      arrival_id: "MAD",
      outbound_date: "2026-08-01",
      type: "2",
      currency: "USD",
    })
  })

  it("passes a round trip's return date and travel class through", () => {
    expect(
      toolParams("google_flights_search", {
        departure_id: "SCL",
        arrival_id: "MAD",
        outbound_date: "2026-08-01",
        return_date: "2026-08-15",
        type: "1",
        travel_class: "3",
      })
    ).toMatchObject({
      type: "1",
      return_date: "2026-08-15",
      travel_class: "3",
    })
  })

  it("derives the trip type from the return date, not the model's claim", () => {
    // Regression: a model claimed type "1" (round trip) with no return
    // date and SerpApi rejected the call with a 400.
    expect(
      toolParams("google_flights_search", {
        departure_id: "JFK",
        arrival_id: "BCN",
        outbound_date: "2026-09-03",
        type: "1",
      })
    ).toMatchObject({ type: "2" })
    expect(
      toolParams("google_flights_search", {
        departure_id: "JFK",
        arrival_id: "BCN",
        outbound_date: "2026-09-03",
        return_date: "2026-09-10",
        type: "2",
      })
    ).toMatchObject({ type: "1", return_date: "2026-09-10" })
  })

  it("defaults hotels to 2 adults in USD", () => {
    expect(
      toolParams("google_hotels_search", {
        query: "hotels in Barcelona",
        check_in_date: "2026-08-01",
        check_out_date: "2026-08-04",
      })
    ).toEqual({
      engine: "google_hotels",
      q: "hotels in Barcelona",
      check_in_date: "2026-08-01",
      check_out_date: "2026-08-04",
      adults: 2,
      currency: "USD",
    })
  })

  it("builds a google_shopping request and drops a bloc gl", () => {
    expect(
      toolParams("google_shopping_search", { query: "airpods pro 2" })
    ).toEqual({ engine: "google_shopping", q: "airpods pro 2" })
    expect(
      toolParams("google_shopping_search", {
        query: "airpods pro 2",
        gl: "latam",
      })
    ).not.toHaveProperty("gl")
  })
})

describe("stripInlineToolCalls", () => {
  it("leaves clean prose untouched", () => {
    expect(stripInlineToolCalls("NVDA is trading at $194.83.")).toBe(
      "NVDA is trading at $194.83."
    )
  })

  it("removes a well-formed tool_call block and keeps the prose", () => {
    expect(
      stripInlineToolCalls(
        'Let me check.\n<tool_call>{"name":"google_search"}</tool_call>'
      )
    ).toBe("Let me check.")
  })

  it("drops trailing argument soup from malformed inline calls", () => {
    // Regression: glm-4.6v-flash interleaved broken tool-call XML into
    // its answer prose instead of emitting a well-formed block.
    const answer =
      "I will now search for hotels in Barcelona.\n</tool_call>sort</arg_key>\n<arg_value>best_match</arg_value>\n</tool_call>max_price</arg_key>"
    expect(stripInlineToolCalls(answer)).toBe(
      "I will now search for hotels in Barcelona."
    )
  })
})

describe("isEmptyFinanceResponse", () => {
  it("treats a response with no quote, stats, or news as empty", () => {
    expect(isEmptyFinanceResponse({})).toBe(true)
    expect(
      isEmptyFinanceResponse({
        summary: {},
        knowledge_graph: { key_stats: { stats: [] } },
        news_results: [],
      })
    ).toBe(true)
  })

  it("keeps a response that has a usable quote", () => {
    expect(isEmptyFinanceResponse({ summary: { title: "Apple Inc" } })).toBe(
      false
    )
    expect(isEmptyFinanceResponse({ summary: { price: "$255.46" } })).toBe(
      false
    )
  })

  it("keeps a response that only has stats or news", () => {
    expect(
      isEmptyFinanceResponse({
        knowledge_graph: { key_stats: { stats: [{ label: "P/E" }] } },
      })
    ).toBe(false)
    expect(
      isEmptyFinanceResponse({ news_results: [{ title: "Markets rally" }] })
    ).toBe(false)
  })
})

describe("extractSources", () => {
  it("lists tool SERPs first, then links cited in the answer", () => {
    const sources = extractSources(
      "See [Apple](https://apple.com) for details.",
      [{ label: "Finance · AAPL", url: "https://google.com/finance?q=AAPL" }]
    )
    expect(sources).toEqual([
      { label: "Finance · AAPL", url: "https://google.com/finance?q=AAPL" },
      { label: "Apple", url: "https://apple.com" },
    ])
  })

  it("dedupes by URL across tool sources and answer links", () => {
    const url = "https://google.com/search?q=chips"
    const sources = extractSources(`Source: [the SERP](${url})`, [
      { label: "Search · chips", url },
      { label: "Search · chips (again)", url },
    ])
    expect(sources).toEqual([{ label: "Search · chips", url }])
  })

  it("returns an empty list when there are no tools and no links", () => {
    expect(extractSources("No links here.", [])).toEqual([])
  })
})
