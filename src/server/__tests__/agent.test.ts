import { afterEach, describe, expect, it } from "vitest"

import {
  TOOLS,
  answerCallHint,
  buildSystemPrompt,
  classifyLoadResponse,
  contextBackoffSequence,
  contextOverride,
  extractSources,
  hasInlineToolCall,
  isEmptyFinanceResponse,
  isTransientSerpApiError,
  isUnparseableReply,
  missingAnswerNotice,
  normalizeCountryCode,
  parseInlineToolCalls,
  parseLmStudioModels,
  promptOverBudget,
  recommendedContext,
  redactSecrets,
  restrictorFor,
  reusableLoad,
  runToolLoop,
  sanitizeHistoryForReplay,
  serpApiErrorText,
  serpApiHint,
  splitMarkdownFrontMatter,
  stripInlineToolCalls,
  sumUsage,
  toExactUsage,
  toolParams,
  trimHistoryToFit,
  uniqueInstances,
  unsupportedParam,
  validateToolArgs,
} from "../agent"
import {
  MARKDOWN_RESTRICTORS,
  RESTRICTORS,
  RESTRICTOR_TOOLS,
} from "../restrictors"

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"

// Tests cover the pure helpers around the SerpApi tool loop: history
// sanitisation, secret redaction, inline-XML tool-call parsing, sliding-
// window history trimming, country-code normalisation, tool-arg
// validation, per-engine request building, the empty-finance fallback
// signal, and sources extraction. SerpApi response shaping is handled
// server-side by `json_restrictor`, so there is no client-side formatter
// to test.

describe("sanitizeHistoryForReplay", () => {
  it("drops the tool cycle but keeps the answer, labelled as possibly stale", () => {
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
    // Real-usage test, 2026-10-02: with only a placeholder, "which of those
    // has the best rating?" re-searched and named hotels that were not in
    // the list, and Muse repeated the placeholder as its answer.
    expect(out[1].content).toMatch(
      /^\[Earlier answer, written from a live search/
    )
    expect(out[1].content).toContain("Here are the flights... | LATAM | $635 |")
    // The raw tool result itself never comes back.
    expect(JSON.stringify(out)).not.toContain('{\\"table\\"')
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
    // user/greet/user/labelled answer, tool_calls + tool messages dropped.
    expect(out).toHaveLength(4)
    expect(out[0]).toEqual({ role: "user", content: "Hi" })
    expect(out[1]).toEqual({ role: "assistant", content: "Hello!" })
    expect(out[2]).toEqual({ role: "user", content: "Price of NVDA?" })
    expect(out[3].content).toMatch(/may be out of date/)
    expect(out[3].content).toContain("NVDA is $199.")
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

  it("parses Gemma 4's own tool-call format", () => {
    // Verbatim from Gemma 4 12B on 2026-10-02: it leaked out as the answer.
    const content =
      '<|tool_call>call:google_search{gl:<|"|>mx<|"|>,hl:<|"|>es<|"|>,query:<|"|>precio Toyota Corolla 2026 México<|"|>}'
    expect(hasInlineToolCall(content)).toBe(true)
    expect(parseInlineToolCalls(content)).toEqual([
      {
        name: "google_search",
        rawArgs: JSON.stringify({
          gl: "mx",
          hl: "es",
          query: "precio Toyota Corolla 2026 México",
        }),
        args: {
          gl: "mx",
          hl: "es",
          query: "precio Toyota Corolla 2026 México",
        },
      },
    ])
    expect(stripInlineToolCalls(`Let me check.\n${content}<tool_call|>`)).toBe(
      "Let me check."
    )
  })

  it("parses the follow-up search Qwen wrote instead of an answer", () => {
    // Verbatim from LM Studio's log, Shopping in Markdown (Restrictor).
    const content =
      "\n\nThe results above are mostly charging cases, not the earbuds themselves. Let me search specifically for the AirPods Pro earbuds.\n\n<tool_call>\n<function=google_shopping_search>\n<parameter=query>\nApple AirPods Pro 2 earbuds\n</parameter>\n<parameter=hl>\nen\n</parameter>\n<parameter=gl>\nus\n</parameter>\n</function>\n</tool_call>"
    expect(parseInlineToolCalls(content)).toEqual([
      {
        name: "google_shopping_search",
        rawArgs: JSON.stringify({
          query: "Apple AirPods Pro 2 earbuds",
          hl: "en",
          gl: "us",
        }),
        args: { query: "Apple AirPods Pro 2 earbuds", hl: "en", gl: "us" },
      },
    ])
  })
})

describe("trimHistoryToFit", () => {
  // Four characters per token is close enough to order messages by size.
  const measure = (value: unknown) =>
    Math.ceil(JSON.stringify(value).length / 4)

  it("returns the same history when no trimming is needed", () => {
    const history: Array<ChatCompletionMessageParam> = [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ]
    const { trimmed, dropped } = trimHistoryToFit(history, 0, 100_000, measure)
    expect(dropped).toBe(0)
    expect(trimmed).toEqual(history)
  })

  it("drops whole turns, oldest first, when over budget", () => {
    const big = "lorem ipsum ".repeat(200)
    const history: Array<ChatCompletionMessageParam> = [
      { role: "user", content: `OLDEST: ${big}` },
      { role: "assistant", content: `MIDDLE: ${big}` },
      { role: "user", content: `NEWER: ${big}` },
      { role: "assistant", content: `NEWEST: ${big}` },
    ]
    // Budget for three of the four messages: the oldest question goes, and
    // its answer with it, so the history still starts with a question.
    const budget = Math.ceil((measure(history.slice(1)) + 1) / 0.7)
    const { trimmed, dropped } = trimHistoryToFit(history, 0, budget, measure)
    expect(dropped).toBe(1)
    expect(trimmed.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(JSON.stringify(trimmed)).toContain("NEWER")
  })

  it("never leaves an answer at the front without its question", () => {
    const history: Array<ChatCompletionMessageParam> = [
      { role: "assistant", content: "orphan" },
      { role: "user", content: "Hi" },
    ]
    const { trimmed } = trimHistoryToFit(history, 0, 100_000, measure)
    expect(trimmed.map((m) => m.role)).toEqual(["user"])
  })

  it("is a no-op for empty history", () => {
    const { trimmed, dropped } = trimHistoryToFit([], 0, 100, measure)
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
  it("steps down in quarters from the start to the 4K floor, largest first", () => {
    expect(contextBackoffSequence(32768)).toEqual([
      32768, 24576, 16384, 12288, 8192, 4096,
    ])
  })

  it("lands closer to the limit than halving would", () => {
    // Measured on a 36 GB Mac: Gemma 4 31B fits at 36,864 but not 40,960.
    // Halving from 49,152 would drop straight to 24,576.
    expect(contextBackoffSequence(49152).slice(0, 2)).toEqual([49152, 36864])
  })

  it("always ends on the 4K floor and never repeats a size", () => {
    expect(contextBackoffSequence(12288)).toEqual([12288, 9216, 6144, 4096])
    expect(contextBackoffSequence(4096)).toEqual([4096])
  })

  it("rounds sizes down to a clean 1024 step", () => {
    expect(contextBackoffSequence(33000)).toEqual([
      32768, 24576, 16384, 12288, 8192, 4096,
    ])
  })

  it("returns an empty schedule when the start is below the minimum", () => {
    expect(contextBackoffSequence(2048)).toEqual([])
  })
})

describe("classifyLoadResponse", () => {
  // Bodies captured from LM Studio 0.4.25 on 2026-10-01.
  it("reads the applied context from a successful load", () => {
    expect(
      classifyLoadResponse(200, {
        status: "loaded",
        load_config: { context_length: 61696, parallel: 4 },
      })
    ).toEqual({ kind: "loaded", applied: 61696 })
    expect(classifyLoadResponse(200, { status: "loaded" })).toEqual({
      kind: "loaded",
      applied: null,
    })
  })

  it("treats only a guardrail refusal as a reason to try smaller", () => {
    const refusal = classifyLoadResponse(500, {
      error: {
        type: "model_load_failed",
        message:
          "Failed to load LLM 'google/gemma-4-31b-qat': Error: Model loading was stopped due to insufficient system resources. Under the current settings, this model requires approximately 52.40 GB of memory",
      },
    })
    expect(refusal.kind).toBe("refused")
  })

  it("reports every other failure as it is", () => {
    expect(
      classifyLoadResponse(404, {
        error: {
          type: "model_not_found",
          message: "Model nonexistent/model-xyz not found in downloaded models",
        },
      })
    ).toEqual({
      kind: "failed",
      message: "Model nonexistent/model-xyz not found in downloaded models",
    })
    expect(
      classifyLoadResponse(500, {
        error: "LM Link connection entered error state peer_keepalive_timeout",
      }).kind
    ).toBe("failed")
    expect(classifyLoadResponse(502, "Bad gateway")).toEqual({
      kind: "failed",
      message: "LM Studio returned HTTP 502.",
    })
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

describe("validateToolArgs digit-only values", () => {
  it("accepts numbers where a string is expected", () => {
    // The inline parsers, and some models' JSON args, turn "2" into 2.
    expect(
      validateToolArgs("google_flights_search", {
        departure_id: "EZE",
        arrival_id: "MVD",
        outbound_date: "2026-10-09",
        type: 2,
        travel_class: 1,
      })
    ).toMatchObject({ type: "2", travel_class: "1" })
    expect(validateToolArgs("google_search", { query: 1984 })).toMatchObject({
      query: "1984",
    })
  })

  it("still rejects values outside an enum", () => {
    expect(() =>
      validateToolArgs("google_flights_search", {
        departure_id: "EZE",
        arrival_id: "MVD",
        outbound_date: "2026-10-09",
        type: 3,
      })
    ).toThrow(/type/)
  })
})

describe("toolParams for cities with several airports", () => {
  it("passes every airport, without the spaces a model may add", () => {
    // Real-usage test, 2026-10-02: Gemma searched only EZE for Buenos Aires.
    const params = toolParams("google_flights_search", {
      departure_id: "MVD",
      arrival_id: "EZE, AEP",
      outbound_date: "2026-11-20",
    })
    expect(params.arrival_id).toBe("EZE,AEP")
  })

  it("lists several airports in the tool definition", () => {
    const flights = TOOLS.find((t) =>
      JSON.stringify(t).includes('"google_flights_search"')
    )
    expect(JSON.stringify(flights)).toMatch(/several airports/)
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
    // "eu" is rejected by SerpApi as `gl`. It must become a no-op, not a 4xx.
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

describe("parseLmStudioModels", () => {
  const good = {
    key: "qwen/qwen3.8-27b",
    display_name: "Qwen 3.8 27B",
    type: "llm",
    architecture: "qwen3_5",
    params_string: "27B",
    max_context_length: 262144,
    format: "mlx",
    loaded_instances: [
      { id: "qwen/qwen3.8-27b", config: { context_length: 32768 } },
    ],
    capabilities: { trained_for_tool_use: true },
  }

  it("keeps valid entries and skips the ones it can't read", () => {
    const models = parseLmStudioModels({
      models: [good, { key: 42 }, { ...good, key: "x", format: "onnx" }],
    })
    expect(models?.map((m) => m.key)).toEqual(["qwen/qwen3.8-27b", "x"])
    expect(models?.[1].format).toBeNull()
  })

  it("returns null when the payload is not a model list", () => {
    expect(parseLmStudioModels({ data: [] })).toBeNull()
    expect(parseLmStudioModels("oops")).toBeNull()
  })
})

describe("uniqueInstances", () => {
  it("collapses the same instance listed once per LM Link device", () => {
    const a = { id: "qwen/qwen3.8-27b", model: "qwen/qwen3.8-27b", ctx: 32768 }
    const b = { id: "gemma", model: "gemma", ctx: 8192 }
    expect(uniqueInstances([a, { ...a }, b])).toEqual([a, b])
  })
})

describe("reusableLoad", () => {
  const one = [{ ctx: 24576 }]

  it("reuses a stepped-down load when the caller asks for the same start size", () => {
    const record = {
      target: 32768,
      loaded: { requested: 24576, applied: 24576 },
    }
    expect(reusableLoad(record, one, 32768)).toEqual(record.loaded)
  })

  it("reloads when the caller asks for a different size", () => {
    const record = {
      target: 32768,
      loaded: { requested: 24576, applied: 24576 },
    }
    expect(reusableLoad(record, one, 16384)).toBeNull()
  })

  it("reuses a model loaded elsewhere at exactly the target size", () => {
    expect(reusableLoad(undefined, [{ ctx: 32768 }], 32768)).toEqual({
      requested: 32768,
      applied: 32768,
    })
  })

  it("reloads when nothing or more than one instance is loaded", () => {
    const record = {
      target: 32768,
      loaded: { requested: 32768, applied: null },
    }
    expect(reusableLoad(record, [], 32768)).toBeNull()
    expect(reusableLoad(record, [...one, ...one], 32768)).toBeNull()
  })
})

describe("parseInlineToolCalls inside reasoning", () => {
  it("ignores tool calls the model only wrote while thinking", () => {
    const content =
      "<think>Maybe <tool_call><function=google_search><parameter=query>x</parameter></function></tool_call></think>The answer is 4."
    expect(parseInlineToolCalls(content)).toEqual([])
  })
})

describe("hasInlineToolCall", () => {
  it("flags prose that ends in another tool call", () => {
    expect(
      hasInlineToolCall(
        "Let me search more specifically.\n\n<tool_call>\n<function=google_shopping_search>\n<parameter=query>\nAirPods Pro 3\n</parameter>\n</function>\n</tool_call>"
      )
    ).toBe(true)
  })

  it("ignores a plain answer and tags inside reasoning", () => {
    expect(hasInlineToolCall("The CEO of Apple is John Ternus.")).toBe(false)
    expect(
      hasInlineToolCall("<think>maybe <tool_call> again</think>The answer.")
    ).toBe(false)
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

  it("removes a leaked <think> block from a thinking model", () => {
    // Qwen 3.x emits reasoning in <think> tags. LM Studio normally moves
    // it to `message.reasoning`, but with its parser off it lands in
    // `content` and would render as literal text.
    expect(
      stripInlineToolCalls(
        "<think>\nThe user wants the price. I have it.\n</think>\n\nNVDA is at $194.83."
      )
    ).toBe("NVDA is at $194.83.")
  })

  it("removes an unterminated thinking prefix", () => {
    // Some templates strip the opening tag but leave the closing one.
    expect(
      stripInlineToolCalls(
        "Let me reason about this.\n</think>\nThe answer is 4."
      )
    ).toBe("The answer is 4.")
  })
})

describe("splitMarkdownFrontMatter", () => {
  // Shape of a live `output=md` response with the Finance restrictor
  // applied (captured 2026-09-12).
  const sample = [
    "---",
    "search_metadata:",
    '  google_finance_url: "https://www.google.com/finance/quote/NVDA:NASDAQ?hl=en"',
    "---",
    "",
    "## Summary",
    "",
    "- Title: NVIDIA Corp",
    "- Price: USD218.29",
  ].join("\n")

  it("lifts the SERP url out of the front matter and returns the body", () => {
    const { searchUrl, body } = splitMarkdownFrontMatter(sample)
    expect(searchUrl).toBe(
      "https://www.google.com/finance/quote/NVDA:NASDAQ?hl=en"
    )
    expect(body.startsWith("## Summary")).toBe(true)
    expect(body).not.toContain("search_metadata")
  })

  it("handles the unrestricted front matter with several metadata keys", () => {
    const full = [
      "---",
      "search_metadata:",
      "  id: abc",
      "  status: Success",
      '  json_endpoint: "https://serpapi.com/searches/x.json"',
      '  google_url: "https://www.google.com/search?q=coffee"',
      "search_parameters:",
      "  engine: google",
      "---",
      "## Organic Results",
    ].join("\n")
    const { searchUrl, body } = splitMarkdownFrontMatter(full)
    expect(searchUrl).toBe("https://www.google.com/search?q=coffee")
    expect(body).toBe("## Organic Results")
  })

  it("passes text without front matter through untouched", () => {
    const { searchUrl, body } = splitMarkdownFrontMatter("## Just a body\n")
    expect(searchUrl).toBeNull()
    expect(body).toBe("## Just a body")
  })
})

describe("restrictorFor", () => {
  it("sends the tight restrictor in JSON and the looser one in Markdown", () => {
    for (const tool of RESTRICTOR_TOOLS) {
      expect(restrictorFor(tool, "json")).toBe(RESTRICTORS[tool])
      expect(restrictorFor(tool, "markdown")).toBe(MARKDOWN_RESTRICTORS[tool])
    }
  })

  it("sends no restrictor in Markdown (Raw) mode", () => {
    for (const tool of RESTRICTOR_TOOLS) {
      expect(restrictorFor(tool, "markdown-full")).toBeNull()
    }
  })

  it("keeps the SERP url every restrictor needs for the Sources panel", () => {
    for (const tool of RESTRICTOR_TOOLS) {
      expect(RESTRICTORS[tool]).toMatch(/search_metadata\.google\w*_url/)
      expect(MARKDOWN_RESTRICTORS[tool]).toMatch(
        /search_metadata\.google\w*_url/
      )
    }
  })

  it("keeps SerpApi's error, so the model hears when a search found nothing", () => {
    // Smoke test, 2026-10-05: an empty flight search reached Gemma as
    // nothing at all, and it blamed the date.
    for (const tool of RESTRICTOR_TOOLS) {
      expect(RESTRICTORS[tool].split(",")).toContain("error")
      expect(MARKDOWN_RESTRICTORS[tool].split(",")).toContain("error")
    }
  })
})

describe("isEmptyFinanceResponse", () => {
  it("treats a Markdown quote without a price line as empty", () => {
    expect(isEmptyFinanceResponse("## Summary\n\n## Knowledge Graph\n")).toBe(
      true
    )
    expect(
      isEmptyFinanceResponse(
        "## Summary\n\n- Title: NVIDIA Corp\n- Price: USD218.29"
      )
    ).toBe(false)
  })

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

describe("sumUsage", () => {
  const u = (p: number, c: number) => ({
    prompt_tokens: p,
    completion_tokens: c,
    total_tokens: p + c,
  })

  it("sums every completion in the turn and counts them", () => {
    expect(sumUsage([u(1000, 20), u(1200, 90)])).toEqual({
      promptTokens: 2200,
      completionTokens: 110,
      totalTokens: 2310,
      completions: 2,
    })
  })

  it("returns null when any completion lacked usage, never a partial total", () => {
    expect(sumUsage([u(1000, 20), undefined])).toBeNull()
    expect(sumUsage([null])).toBeNull()
    expect(sumUsage([])).toBeNull()
  })
})

describe("answerCallHint", () => {
  it("says the tool results outgrew the context when LM Studio rejects the size", () => {
    expect(
      answerCallHint(
        '400 "Engine protocol predict request returned 400: {\\"error\\":{\\"code\\":400,\\"message\\":\\"request (63382 tokens) exceeds the available context size (32768 tokens), try increasing it\\"}}"'
      )
    ).toMatch(/larger than the 32,768-token context/)
  })

  it("names malformed model output and LM Link drops", () => {
    expect(
      answerCallHint(
        "The model produced output that does not match the expected peg-native format"
      )
    ).toMatch(/output LM Studio could not parse/)
    expect(answerCallHint("LM Link connection closed")).toMatch(/LM Link/)
    expect(answerCallHint("socket hang up")).toMatch(/stalled/)
  })

  it("says a timeout is the model being slow, not LM Studio being down", () => {
    expect(answerCallHint("Request timed out.")).toMatch(
      /did not finish in time/
    )
  })
})

describe("promptOverBudget", () => {
  it("names the overflow when the model read more than the app loaded", () => {
    // Qwen (MLX) read 33,371 tokens at a 32,768 load on 2026-10-01.
    expect(promptOverBudget(33371, 32768)).toBe(
      "The prompt (33,371 tokens) is over the 32,768-token context the app loaded."
    )
  })

  it("lets prompts that fit, or an unknown budget, through", () => {
    expect(promptOverBudget(32768, 32768)).toBeNull()
    expect(promptOverBudget(5000, null)).toBeNull()
    expect(promptOverBudget(undefined, 32768)).toBeNull()
  })
})

describe("unsupportedParam", () => {
  it("names the parameter SerpApi refused", () => {
    // Real-usage test, 2026-10-02: a Shopping search inherited gl=uy.
    expect(
      unsupportedParam(
        "SerpApi request failed: Unsupported `uy` country - gl parameter."
      )
    ).toBe("gl")
    expect(unsupportedParam("Unsupported `xx` language - hl parameter.")).toBe(
      "hl"
    )
    expect(unsupportedParam("Invalid API key.")).toBeNull()
  })
})

describe("serpApiHint", () => {
  it("only blames the API key when SerpApi says so", () => {
    expect(serpApiHint("Unsupported `uy` country - gl parameter.")).toMatch(
      /does not support/
    )
    expect(serpApiHint("Invalid API key. Your API key should be here")).toMatch(
      /SERPAPI_API_KEY/
    )
    expect(serpApiHint("Your account has run out of searches.")).toMatch(
      /quota|searches/
    )
    expect(serpApiHint("HTTP 503")).toMatch(/serpapi.com\/status/)
  })
})

describe("isTransientSerpApiError", () => {
  it("retries a SerpApi 5xx once, nothing else", () => {
    // Real-usage test, 2026-10-02: one search came back HTTP 503.
    expect(isTransientSerpApiError("SerpApi request failed: HTTP 503")).toBe(
      true
    )
    expect(isTransientSerpApiError("SerpApi request failed: HTTP 502")).toBe(
      true
    )
    expect(
      isTransientSerpApiError("SerpApi request failed: Invalid API key.")
    ).toBe(false)
    expect(isTransientSerpApiError("SerpApi timed out after 45s.")).toBe(false)
  })

  it("uses the status code when the message no longer has it", () => {
    // Markdown mode replaces "HTTP 503" with the body's `error` text.
    expect(isTransientSerpApiError("SerpApi request failed: Busy", 503)).toBe(
      true
    )
    expect(isTransientSerpApiError("SerpApi request failed: Busy", 400)).toBe(
      false
    )
  })

  it("recognises a 5xx page the SDK passes on as the error", () => {
    expect(
      isTransientSerpApiError(
        "SerpApi request failed: 503 Service Temporarily Unavailable"
      )
    ).toBe(true)
  })
})

describe("serpApiErrorText", () => {
  it("reads the error string out of SerpApi's JSON body", () => {
    // The SDK rejects a failed JSON search with the raw response body.
    expect(
      serpApiErrorText(
        '{"error":"Invalid API key. Your API key should be here"}'
      )
    ).toBe("Invalid API key. Your API key should be here")
  })

  it("falls back to the page title, then a short slice of the body", () => {
    expect(
      serpApiErrorText(
        "<html><head><title>503 Service Temporarily Unavailable</title></head></html>"
      )
    ).toBe("503 Service Temporarily Unavailable")
    expect(serpApiErrorText("x".repeat(500))).toHaveLength(200)
  })
})

describe("runToolLoop", () => {
  // A completion that only carries the tool calls the fake `readCalls`
  // returns for it: the loop never looks inside a completion itself.
  type Fake = { id: number; calls: Array<string> }

  // Scripted model: one entry per completion, the searches it asks for.
  function script(replies: Array<Array<string>>) {
    const choices: Array<"auto" | "none"> = []
    const rounds: Array<Array<string>> = []
    let next = 0
    return {
      choices,
      rounds,
      opts: {
        complete: (toolChoice: "auto" | "none") => {
          choices.push(toolChoice)
          const id = next++
          return Promise.resolve({ id, calls: replies[id] ?? [] } as Fake)
        },
        readCalls: (c: Fake) => c.calls,
        runRound: (calls: Array<string>) => {
          rounds.push(calls)
          return Promise.resolve()
        },
      },
    }
  }

  it("stops when the model answers after the first round", async () => {
    const s = script([[]])
    const result = await runToolLoop({ maxToolRounds: 3, ...s.opts })
    expect(result.rounds).toBe(1)
    expect(result.last.id).toBe(0)
    expect(s.choices).toEqual(["auto"])
    expect(s.rounds).toEqual([])
  })

  it("runs another round when the model searches again", async () => {
    const s = script([["google_news_search"], []])
    const result = await runToolLoop({ maxToolRounds: 3, ...s.opts })
    expect(result.rounds).toBe(2)
    expect(s.rounds).toEqual([["google_news_search"]])
    expect(s.choices).toEqual(["auto", "auto"])
  })

  it("turns tools off once the cap is reached", async () => {
    const s = script([["google_search"], ["google_search"], ["google_search"]])
    const result = await runToolLoop({ maxToolRounds: 3, ...s.opts })
    expect(result.rounds).toBe(3)
    expect(s.rounds).toHaveLength(2)
    // The call after the third round may not search, like the last round
    // of LM Studio's `.act()`.
    expect(s.choices).toEqual(["auto", "auto", "none"])
    expect(result.last.id).toBe(2)
  })

  it("keeps the results so far when a later round fails", async () => {
    const s = script([["google_search"], []])
    const failures: Array<unknown> = []
    const result = await runToolLoop({
      maxToolRounds: 3,
      ...s.opts,
      runRound: () => Promise.reject(new Error("SerpApi 503")),
      onRoundFailed: (err) => failures.push(err),
    })
    expect(result.rounds).toBe(1)
    expect(result.last.id).toBe(0)
    expect(failures).toHaveLength(1)
  })

  it("treats unreadable tool calls like a failed round", async () => {
    const s = script([["google_search"]])
    const result = await runToolLoop({
      maxToolRounds: 3,
      ...s.opts,
      readCalls: () => {
        throw new Error("non-JSON tool args")
      },
    })
    expect(result.rounds).toBe(1)
    expect(s.choices).toEqual(["auto"])
  })
})

describe("buildSystemPrompt", () => {
  // The loop keeps the tools on after the first round, so the prompt must
  // not tell the model it can't search again (docs/agent-loop.md).
  it("allows another search when the results missed", () => {
    const prompt = buildSystemPrompt()
    expect(prompt).not.toContain("cannot search again")
    expect(prompt).toContain("you may search again with a better query")
  })
})

describe("toExactUsage / sumUsage with reasoning", () => {
  const call = (prompt: number, out: number, reasoning?: number) => ({
    prompt_tokens: prompt,
    completion_tokens: out,
    total_tokens: prompt + out,
    ...(reasoning === undefined
      ? {}
      : { completion_tokens_details: { reasoning_tokens: reasoning } }),
  })

  it("keeps the reasoning tokens LM Studio reports", () => {
    expect(toExactUsage(call(1008, 60, 57))).toEqual({
      promptTokens: 1008,
      completionTokens: 60,
      totalTokens: 1068,
      reasoningTokens: 57,
    })
    expect(toExactUsage(call(1008, 60))).not.toHaveProperty("reasoningTokens")
  })

  it("sums reasoning only when every call reported it", () => {
    expect(sumUsage([call(10, 5, 3), call(20, 6, 4)])).toMatchObject({
      completionTokens: 11,
      reasoningTokens: 7,
      completions: 2,
    })
    expect(sumUsage([call(10, 5, 3), call(20, 6)])).not.toHaveProperty(
      "reasoningTokens"
    )
  })
})

describe("isUnparseableReply", () => {
  it("matches LM Studio's parse failure, not other errors", () => {
    expect(
      isUnparseableReply(
        '400 "Engine protocol predict stream returned an error: {"code":500,"message":"The model produced output that does not match the expected peg-native format"}"'
      )
    ).toBe(true)
    expect(isUnparseableReply("Request timed out.")).toBe(false)
  })
})

describe("missingAnswerNotice", () => {
  // What Qwen 3.8 27B wrote on the forced-answer call, 2026-10-09.
  const qwen =
    "\n\n<tool_call>\n<function=google_search>\n<parameter=query>\nSerpApi pricing plans 2026\n</parameter>\n</function>\n</tool_call>"

  it("names the search the model still wanted after the last round", () => {
    expect(missingAnswerNotice(qwen, 3, false)).toBe(
      'The model used all 3 search rounds and asked for another search ("SerpApi pricing plans 2026") instead of answering, so the results so far didn\'t have what it needed. Try a more specific question, or another model.'
    )
  })

  it("reads Gemma 4's own call format too", () => {
    const gemma =
      '<|tool_call>call:google_search{query:<|"|>when was SerpApi founded<|"|>}<tool_call|>'
    expect(missingAnswerNotice(gemma, 1, false)).toContain(
      'asked for another search ("when was SerpApi founded")'
    )
    expect(missingAnswerNotice(gemma, 1, false)).not.toContain("rounds")
  })

  it("explains a reply cut off by the token budget", () => {
    expect(missingAnswerNotice("", 1, true)).toMatch(/reply budget/)
  })

  it("falls back to the generic notice", () => {
    expect(missingAnswerNotice("", 1, false)).toMatch(/empty response/)
  })
})
