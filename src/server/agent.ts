// Server only: import protection fails the build if a route or component
// imports this file. Routes reach it through the server functions in
// `chat.ts`, `bench.ts` and `models.ts`, whose handlers the client build
// replaces with RPC stubs.
import "@tanstack/react-start/server-only"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { createServerOnlyFn } from "@tanstack/react-start"
import OpenAI from "openai"
import {
  InvalidArgumentError,
  MissingApiKeyError,
  getJson,
  config as serpApiConfig,
} from "serpapi"
import { z } from "zod"

import {
  MARKDOWN_RESTRICTORS,
  RESTRICTORS,
  isRestrictorTool,
} from "./restrictors"
import { countTokens } from "./tokens.server"

import type { RestrictorTool } from "./restrictors"
import type {
  Breakdown,
  ExactUsage,
  FullResponseResult,
  JsonValue,
  ModelInfo,
  Phases,
  QueryProgress,
  Source,
  ToolArgs,
  ToolCallInfo,
  ToolOutput,
} from "@/lib/agent-types"
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions"
import {
  MAX_COMPLETION_TOKENS,
  TOOL_OUTPUTS,
  contextTotal,
} from "@/lib/agent-types"

// Shared, browser-safe types and constants live in `@/lib/agent-types`.
// They're re-exported here so server-side callers (and tests) can keep a
// single import; client code should import from `@/lib/agent-types`.
export {
  CONTEXT_SEGMENTS,
  TOOL_OUTPUTS,
  TOOL_OUTPUT_META,
  contextTotal,
  isToolOutput,
} from "@/lib/agent-types"
export type {
  Breakdown,
  ExactUsage,
  FullResponseResult,
  JsonValue,
  ModelInfo,
  Phases,
  QueryProgress,
  Source,
  ToolArgValue,
  ToolArgs,
  ToolCallInfo,
  ToolOutput,
} from "@/lib/agent-types"

// ─── Module overview ───────────────────────────────────
// Everything SerpApi + LM Studio lives in this file on purpose: you should
// be able to open ONE file and trace the whole flow top-to-bottom (tools →
// executors → orchestration) without jumping across modules. SerpApi's
// `json_restrictor` (see `restrictors.ts`) does the response trimming
// server-side, which is why there is no client-side formatter step.
// `WHY:` explains a non-obvious decision; `NOTE:` clarifies a quirk you'd
// otherwise have to reverse-engineer.

// ─── Endpoints ─────────────────────────────────────────
// LM Studio exposes both an OpenAI-compatible API (`/v1`) and its own native
// admin API (`/api/v1`). Chat traffic goes through the OpenAI path; load /
// unload / model listing go through the native one. Both paths derive from
// one base URL so LMSTUDIO_URL moves them together (non-default port, or a
// server on another machine).
//
// WHY: functions, not module-scope constants. Environment variables are read
//      when a request uses them, never at module load, as TanStack Start's
//      environment variables guide asks.
function lmStudioBaseUrl(): string {
  return (process.env.LMSTUDIO_URL ?? "http://localhost:1234").replace(
    /\/+$/,
    ""
  )
}
const lmStudioUrl = () => `${lmStudioBaseUrl()}/v1`
const lmStudioNativeUrl = () => `${lmStudioBaseUrl()}/api/v1`

// LM Studio 0.4 added a "Require Authentication" server setting (off by
// default). With it on, every request needs a token from the Developer
// page, sent as `Authorization: Bearer <token>`.
function lmStudioApiKey(): string | null {
  return process.env.LMSTUDIO_API_KEY?.trim() || null
}

/** Headers for LM Studio's native API, with the token when one is set. */
function lmStudioHeaders(
  extra?: Record<string, string>
): Record<string, string> {
  const key = lmStudioApiKey()
  return { ...extra, ...(key ? { Authorization: `Bearer ${key}` } : {}) }
}

// ─── Timeouts ──────────────────────────────────────────
// Chat is generous because cold-loading a large model can take 30–40s on
// first inference; the others fail fast. SerpApi's value is enforced by the
// SDK config below, not per-call.
const LM_STUDIO_FETCH_TIMEOUT_MS = 10_000
// Sized to let a completion reach `MAX_COMPLETION_TOKENS`. Qwen 3.8 27B on
// a MacBook Pro M5 Pro generates 17.6 tokens/s, so 4,096 tokens take about
// 233 s, reasoning included. At two minutes, a long direct answer timed out.
const LM_STUDIO_CHAT_TIMEOUT_MS = 300_000
// Markdown (Raw) also hands the model up to 30K tokens to read first, at a
// few hundred tokens per second on a laptop.
const LM_STUDIO_CHAT_TIMEOUT_FULL_MS = 480_000
// WHY: a cold model load can take 30–40s. The list/unload calls fail fast
//      (10s), but the load itself gets its own generous budget: time it
//      out too early and a slow-but-valid load looks like a guardrail block,
//      so the back-off probe would shrink the context for no reason.
const LM_STUDIO_LOAD_TIMEOUT_MS = 60_000
// Real searches that SerpApi has not cached, Google Shopping especially,
// took over 20 s in real use on 2026-10-02.
const SERPAPI_TIMEOUT_MS = 45_000

// Idle auto-unload window. The app loads models EXPLICITLY (see
// `tryLoadModel`) so the back-off probe can size context to the machine, but
// an explicit load PINS the model. LM Studio's "Auto unload unused JIT loaded
// models" TTL only ever evicts JIT-loaded models, and a `ttl` on the chat
// request does NOT evict a pinned one (verified against the live server). So
// the app reproduces the idle-unload itself: after each query it arms a timer
// (see `armIdleUnload`) that unloads the model once it has been idle this long.
// Five minutes is this app's own default; override with LMSTUDIO_TTL_SECONDS.
function idleTtlSeconds(): number {
  const raw = Number(process.env.LMSTUDIO_TTL_SECONDS)
  return Number.isFinite(raw) && raw > 0 ? raw : 300
}

// WHY: configure the SerpApi SDK once, on first use rather than at module
//      load. TanStack Start strips server-function bodies from the client
//      bundle but keeps module-scope statements, so a top-level assignment
//      here would drag the SDK into the browser build. Same for the
//      tokenizer below.
let serpApiConfigured = false
function configureSerpApi(): void {
  if (serpApiConfigured) return
  serpApiConfig.timeout = SERPAPI_TIMEOUT_MS
  serpApiConfigured = true
}

/**
 * Dev-only warning helper. Production logs stay quiet; genuine errors still
 * hit `console.error`.
 */
const devWarn = (msg: string, ...args: Array<unknown>): void => {
  if (process.env.NODE_ENV !== "production") {
    console.warn(msg, ...args)
  }
}

// ─── Typed errors ──────────────────────────────────────
// Each error carries an actionable suggestion. The chat surfaces both the
// message and the suggestion verbatim, so the person typing in the chat
// gets a "what to do next" line without ever seeing a stack trace.

/**
 * Base class for all agent-side errors. `suggestion` is the line you
 * show to the user. Keep it short and concrete ("restart LM Studio",
 * "add SERPAPI_API_KEY to .env"), not a stack trace.
 */
class AgentError extends Error {
  readonly suggestion: string
  constructor(message: string, suggestion: string) {
    super(message)
    this.name = "AgentError"
    this.suggestion = suggestion
  }
}

class LmStudioError extends AgentError {
  constructor(message: string, suggestion: string) {
    super(message, suggestion)
    this.name = "LmStudioError"
  }
}

class SerpApiError extends AgentError {
  /** HTTP status when SerpApi answered with one, else null. */
  readonly status: number | null
  constructor(
    message: string,
    suggestion: string,
    status: number | null = null
  ) {
    super(message, suggestion)
    this.name = "SerpApiError"
    this.status = status
  }
}

class ToolArgError extends AgentError {
  constructor(message: string, suggestion: string) {
    super(message, suggestion)
    this.name = "ToolArgError"
  }
}

/**
 * Why a completion must not count, or null when it fits. GGUF models reject
 * a prompt over the loaded context themselves; LM Studio's MLX engine runs
 * it, because it sizes its own window from free memory. Checking the
 * model's own prompt count after the call makes every model live by the
 * window the app asked for. Exported for tests.
 */
export function promptOverBudget(
  promptTokens: number | undefined,
  budget: number | null
): string | null {
  if (promptTokens === undefined || budget === null || promptTokens <= budget)
    return null
  return `The prompt (${promptTokens.toLocaleString("en-US")} tokens) is over the ${budget.toLocaleString("en-US")}-token context the app loaded.`
}

/**
 * True when LM Studio refused a reply it could not parse into the model's
 * tool-call format ("does not match the expected peg-native format").
 * Exported for tests.
 */
export function isUnparseableReply(message: string): boolean {
  return /does not match the expected .*format/i.test(message)
}

/**
 * What to tell the user when an answer call fails, from LM Studio's error
 * text. Exported for tests.
 */
export function answerCallHint(
  message: string,
  fallback = "The model loaded but stalled on the answer call. Try a smaller context or reload the model."
): string {
  const size = message.match(
    /exceeds the available context size \((\d+) tokens\)/
  )
  if (size) {
    return `The tool results are larger than the ${Number(size[1]).toLocaleString("en-US")}-token context. Use a restricted output, or load the model with a bigger context.`
  }
  if (isUnparseableReply(message)) {
    return "The model wrote output LM Studio could not parse. Try again, or pick a different model."
  }
  if (/LM Link/i.test(message)) {
    return "LM Studio lost its LM Link connection to the machine running the model. Check that the linked device is awake and online, then try again."
  }
  if (/timed out/i.test(message)) {
    return "The model did not finish in time. A long answer from a big local model can take minutes; try a faster model or ask for a shorter answer."
  }
  return fallback
}

/**
 * Render an error as Markdown for the chat panel. If you throw an
 * `AgentError`, the `suggestion` shows up in italics under the message;
 * anything else falls back to the raw message.
 */
function formatAgentError(err: unknown): string {
  if (err instanceof AgentError) {
    return `**Error:** ${err.message}\n\n*${err.suggestion}*`
  }
  const msg = err instanceof Error ? err.message : String(err)
  return `**Error:** ${msg}`
}

// ─── Tool definitions ──────────────────────────────────
// One JSON-Schema entry per tool, in the OpenAI function-calling shape.
// LM Studio forwards these to the model as-is.
//
// WHY: notice we use one tool per engine (google_search,
//      google_news_search, …) instead of a single search(engine, query).
//      Small models pick a tool by name reliably but routinely mis-set
//      enum-style parameters. Splitting on the noun-level eliminates a
//      whole class of bugs you'd otherwise have to defend against.

export const TOOLS: Array<ChatCompletionTool> = [
  {
    type: "function",
    function: {
      name: "google_search",
      description:
        "Search Google for web results. Use for general queries, news, current events, or factual questions.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
          num: {
            type: "integer",
            description: "Number of results to return (default 5).",
          },
          gl: {
            type: "string",
            description:
              "ISO 3166-1 alpha-2 country code (e.g. 'us', 'gb', 'de', 'fr', 'jp', 'mx', 'cl'). Must be a single country. Do NOT use regional codes like 'eu', 'apac', 'latam'. If the user mentions a region, pick a representative country.",
          },
          hl: {
            type: "string",
            description:
              "Two-letter language code (e.g. 'en', 'es'). Match the user's language.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "google_finance_search",
      description:
        "Get real-time financial data: stock prices, currencies, indices.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Financial instrument (e.g. 'AAPL:NASDAQ' for stocks, 'USD-CLP' for currencies).",
          },
          hl: {
            type: "string",
            description:
              "Two-letter language code (e.g. 'en', 'es'). Match the user's language.",
          },
          window: {
            type: "string",
            description:
              "Price window: '1D' (default), '5D', '1M', '6M', 'YTD', '1Y', '5Y', 'MAX'. Use when the user asks about performance over a specific range.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "google_news_search",
      description:
        "Real-time Google News results with source and publication date. Use when the question asks about what happened recently.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "The TOPIC ONLY. Do NOT include words like 'news', 'latest', 'breaking', 'últimas', 'noticias'. Good: 'Elasticsearch'. Bad: 'Elasticsearch latest news'. The tool already returns the freshest stories.",
          },
          gl: {
            type: "string",
            description:
              "ISO 3166-1 alpha-2 country code (e.g. 'us', 'gb', 'de', 'fr', 'jp', 'mx', 'cl'). Must be a single country. Do NOT use regional codes like 'eu', 'apac', 'latam'. If the user mentions a region, pick a representative country.",
          },
          hl: {
            type: "string",
            description:
              "Two-letter language code (e.g. 'en', 'es', 'pt'). Set this to match the language the user is writing in.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "google_maps_search",
      description:
        "Search for local businesses or places (restaurants, shops, services) with rating, address, and phone. Use when the question is about finding places.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "What to find plus location, e.g. 'barbecue in Austin, Texas'.",
          },
          gl: {
            type: "string",
            description:
              "ISO 3166-1 alpha-2 country code (e.g. 'us', 'gb', 'de', 'fr', 'jp', 'mx', 'cl'). Must be a single country. Do NOT use regional codes like 'eu', 'apac', 'latam'. If the user mentions a region, pick a representative country.",
          },
          hl: {
            type: "string",
            description:
              "Two-letter language code (e.g. 'en', 'es'). Match the user's language.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "google_flights_search",
      description:
        "Look up flights between two airports on a given date. Requires IATA codes for origin and destination (e.g. 'SCL', 'MAD', 'JFK').",
      parameters: {
        type: "object",
        properties: {
          departure_id: {
            type: "string",
            description:
              "IATA code of the departure airport (e.g. 'SCL'). For a city with several airports, list only that city's airport codes, comma-separated (e.g. 'EZE,AEP' for Buenos Aires).",
          },
          arrival_id: {
            type: "string",
            description:
              "IATA code of the arrival airport (e.g. 'MAD'). For a city with several airports, list only that city's airport codes, comma-separated (e.g. 'LHR,LGW' for London).",
          },
          outbound_date: {
            type: "string",
            description: "Departure date in YYYY-MM-DD format.",
          },
          return_date: {
            type: "string",
            description:
              "Return date in YYYY-MM-DD for round-trips. Omit for one-way.",
          },
          type: {
            type: "string",
            description:
              "'1' for round-trip, '2' for one-way. Default '2' (one-way).",
          },
          currency: {
            type: "string",
            description:
              "Three-letter currency code (e.g. 'USD', 'EUR', 'CLP'). Default 'USD'.",
          },
          hl: {
            type: "string",
            description:
              "Two-letter language code (e.g. 'en', 'es'). Match the user's language.",
          },
          travel_class: {
            type: "string",
            description:
              "'1' Economy (default), '2' Premium economy, '3' Business, '4' First. Set only when the user asks for a specific class.",
          },
        },
        required: ["departure_id", "arrival_id", "outbound_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "google_hotels_search",
      description:
        "Search hotels and vacation rentals for a location and date range, with nightly/total prices, rating, and hotel class. Requires check-in and check-out dates.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Where to stay, e.g. 'hotels in Barcelona' or 'beach resorts in Cancun'.",
          },
          check_in_date: {
            type: "string",
            description: "Check-in date in YYYY-MM-DD format.",
          },
          check_out_date: {
            type: "string",
            description:
              "Check-out date in YYYY-MM-DD format. Must be after check_in_date.",
          },
          adults: {
            type: "integer",
            description: "Number of adults (default 2).",
          },
          currency: {
            type: "string",
            description:
              "Three-letter currency code (e.g. 'USD', 'EUR', 'CLP'). Default 'USD'.",
          },
          gl: {
            type: "string",
            description:
              "ISO 3166-1 alpha-2 country code (e.g. 'us', 'gb', 'de', 'fr', 'jp', 'mx', 'cl'). Must be a single country. Do NOT use regional codes like 'eu', 'apac', 'latam'. If the user mentions a region, pick a representative country.",
          },
          hl: {
            type: "string",
            description:
              "Two-letter language code (e.g. 'en', 'es'). Match the user's language.",
          },
        },
        required: ["query", "check_in_date", "check_out_date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "google_shopping_search",
      description:
        "Search Google Shopping for product listings with price, seller, and rating. Use for price comparisons and 'where to buy' questions.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The product to search for, e.g. 'AirPods Pro 2'.",
          },
          gl: {
            type: "string",
            description:
              "ISO 3166-1 alpha-2 country code (e.g. 'us', 'gb', 'de', 'fr', 'jp', 'mx', 'cl'). Must be a single country. Do NOT use regional codes like 'eu', 'apac', 'latam'. If the user mentions a region, pick a representative country.",
          },
          hl: {
            type: "string",
            description:
              "Two-letter language code (e.g. 'en', 'es'). Match the user's language.",
          },
        },
        required: ["query"],
      },
    },
  },
]

// NOTE: SerpApi responses are dynamic JSON. The executors below probe
//       fields defensively, so `any` is the honest type here: if you
//       lock it down you'll end up casting at every site.
type SerpApiJson = any

function serpApiKey(): string {
  const key = process.env.SERPAPI_API_KEY
  if (!key) {
    throw new SerpApiError(
      "SERPAPI_API_KEY is not set.",
      "Add SERPAPI_API_KEY=<your key> to .env, then restart `bun dev`."
    )
  }
  return key
}

// ─── Zod schemas for tool args ─────────────────────────
// Runtime validation of whatever the model emits. Skip this and a model
// returning `num: "five"` will silently break your executor; `safeParse`
// plus a `ToolArgError` keeps the chat loop alive and surfaces a useful
// suggestion to the user instead of throwing.

// WHY: digit-only values arrive as numbers ("type": 2, a ZIP code, the
//      query "1984"), from the inline parsers and from some models' JSON
//      args. Read them as text instead of failing the turn.
const textArg = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (typeof v === "number" ? String(v) : v), schema)

const googleSearchArgs = z.object({
  query: textArg(z.string().min(1)),
  num: z.number().int().positive().max(20).optional(),
  gl: z.string().optional(),
  hl: z.string().optional(),
})
const googleFinanceArgs = z.object({
  query: textArg(z.string().min(1)),
  hl: z.string().optional(),
  window: z.enum(["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"]).optional(),
})
const googleNewsArgs = z.object({
  query: textArg(z.string().min(1)),
  gl: z.string().optional(),
  hl: z.string().optional(),
})
const googleMapsArgs = z.object({
  query: textArg(z.string().min(1)),
  gl: z.string().optional(),
  hl: z.string().optional(),
})
const googleFlightsArgs = z.object({
  departure_id: textArg(z.string().min(2)),
  arrival_id: textArg(z.string().min(2)),
  outbound_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  return_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  type: textArg(z.enum(["1", "2"])).optional(),
  currency: z.string().optional(),
  hl: z.string().optional(),
  travel_class: textArg(z.enum(["1", "2", "3", "4"])).optional(),
})
const googleHotelsArgs = z.object({
  query: textArg(z.string().min(1)),
  check_in_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  check_out_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  adults: z.number().int().positive().max(20).optional(),
  currency: z.string().optional(),
  gl: z.string().optional(),
  hl: z.string().optional(),
})
const googleShoppingArgs = z.object({
  query: textArg(z.string().min(1)),
  gl: z.string().optional(),
  hl: z.string().optional(),
})

// NOTE: keyed by `RestrictorTool` so this map, `TOOL_EXECUTORS`, and the
//       `RESTRICTORS` map in `restrictors.ts` are guaranteed to cover the
//       exact same set of tools. Add or remove one and the compile fails
//       until all three agree.
const TOOL_SCHEMAS: Record<RestrictorTool, z.ZodType> = {
  google_search: googleSearchArgs,
  google_finance_search: googleFinanceArgs,
  google_news_search: googleNewsArgs,
  google_maps_search: googleMapsArgs,
  google_flights_search: googleFlightsArgs,
  google_hotels_search: googleHotelsArgs,
  google_shopping_search: googleShoppingArgs,
}

/**
 * Run a tool's Zod schema against the model's raw args. Throws
 * `ToolArgError` with a model-friendly suggestion on validation failure.
 */
export function validateToolArgs(toolName: string, rawArgs: unknown): ToolArgs {
  if (!isRestrictorTool(toolName)) {
    throw new ToolArgError(
      `Unknown tool: ${toolName}`,
      "The model picked a tool the server doesn't know about."
    )
  }
  const result = TOOL_SCHEMAS[toolName].safeParse(rawArgs)
  if (!result.success) {
    const details = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ")
    throw new ToolArgError(
      `Tool args failed validation for ${toolName}: ${details}`,
      "The model produced malformed arguments. Small models sometimes do this. Try rephrasing the question."
    )
  }
  return result.data as ToolArgs
}

// ─── Executors ─────────────────────────────────────────
// One executor per tool. They all funnel through `serpApi()` below, which
// uses the SDK's module-level timeout config and converts SDK-specific
// errors into the typed `SerpApiError` so you only handle one error shape.

/**
 * The `json_restrictor` a tool call sends in a given output mode, or
 * `null` for none. JSON sends the tight `RESTRICTORS`; Markdown sends the
 * looser `MARKDOWN_RESTRICTORS`, which spend Markdown's lighter
 * serialisation on more fields at about the same token count; Markdown
 * (Raw) never restricts.
 */
export function restrictorFor(
  name: RestrictorTool,
  output: ToolOutput
): string | null {
  if (output === "markdown-full") return null
  return output === "markdown" ? MARKDOWN_RESTRICTORS[name] : RESTRICTORS[name]
}

const SERPAPI_SEARCH_URL = "https://serpapi.com/search"

/**
 * What to do about a SerpApi error message. Only blames the key or the
 * quota when SerpApi says so. Exported for tests.
 */
export function serpApiHint(message: string): string {
  if (/unsupported/i.test(message)) {
    return "SerpApi does not support that country or language for this search. Ask again without the location, or name another country."
  }
  if (/api[_ ]key/i.test(message)) {
    return "Check SERPAPI_API_KEY in .env, then restart `bun dev`."
  }
  if (/run out of searches|quota|plan/i.test(message)) {
    return "Your SerpApi account is out of searches for this month. Check https://serpapi.com/manage-api-key."
  }
  return "Retry the query, or check https://serpapi.com/status."
}

/**
 * True for a SerpApi server error worth one retry (HTTP 500, 502, 503, 504).
 * Uses the status when there is one; the SDK's JSON path has none, so the
 * message is checked too. Exported for tests.
 */
export function isTransientSerpApiError(
  message: string,
  status: number | null = null
): boolean {
  if (status !== null) return [500, 502, 503, 504].includes(status)
  return /\b50[0234]\b|Service (Temporarily )?Unavailable|Bad Gateway|Gateway Time-?out|Internal Server Error/i.test(
    message
  )
}

const serpApiErrorBody = z.object({ error: z.string() })

/**
 * The readable part of a failed SerpApi response body: SerpApi's `error`
 * string, else the page title, else the first 200 characters.
 *
 * WHY: the SDK rejects a failed JSON search with the raw body, so without
 *      this the user saw `{"error": ...}` or an HTML page as the message.
 */
export function serpApiErrorText(body: string): string {
  try {
    const parsed = serpApiErrorBody.safeParse(JSON.parse(body))
    if (parsed.success) return parsed.data.error
  } catch {
    // not JSON
  }
  const title = body.match(/<title>([^<]{1,200})<\/title>/i)?.[1].trim()
  return title || body.slice(0, 200)
}

/**
 * The search parameter SerpApi refused, from messages like "Unsupported
 * `uy` country - gl parameter.", so the call can retry without it.
 * Exported for tests.
 */
export function unsupportedParam(message: string): "gl" | "hl" | null {
  const m = message.match(/unsupported .* - (gl|hl) parameter/i)
  return m ? (m[1].toLowerCase() as "gl" | "hl") : null
}

/**
 * Map any SerpApi failure onto a `SerpApiError` with a next step. Shared by
 * the SDK path and the Markdown fetch so callers handle one error shape.
 */
function toSerpApiError(err: unknown): SerpApiError {
  if (err instanceof SerpApiError) return err
  if (err instanceof MissingApiKeyError) {
    return new SerpApiError(
      "SERPAPI_API_KEY is not set.",
      "Add SERPAPI_API_KEY=<your key> to .env and restart `bun dev`."
    )
  }
  if (err instanceof InvalidArgumentError) {
    return new SerpApiError(
      `SerpApi rejected the arguments: ${err.message}`,
      "The model produced malformed tool arguments. Zod validation should have caught this. If it did not, try rephrasing the question."
    )
  }
  const msg =
    typeof err === "string"
      ? serpApiErrorText(err)
      : err instanceof Error
        ? err.message
        : String(err)
  // NOTE: the SerpApi SDK surfaces its native timeout as a fetch-style
  //       abort error, which is why we match on /abort|timed out/.
  if (/abort|timed?\s*out/i.test(msg)) {
    return new SerpApiError(
      `SerpApi timed out after ${SERPAPI_TIMEOUT_MS / 1000}s.`,
      "Retry the query, or check https://serpapi.com/status."
    )
  }
  return new SerpApiError(`SerpApi request failed: ${msg}`, serpApiHint(msg))
}

/**
 * Thin wrapper around the SerpApi SDK. Lazy-inits the API key on first
 * call (so you can import this module in tests without env vars set), and
 * maps SDK errors to `SerpApiError` with actionable suggestions.
 */
async function serpApi(params: Record<string, unknown>): Promise<SerpApiJson> {
  configureSerpApi()
  if (!serpApiConfig.api_key) {
    serpApiConfig.api_key = serpApiKey()
  }
  try {
    return await getJson(params)
  } catch (err) {
    if (err instanceof AgentError) throw err
    throw toSerpApiError(err)
  }
}

/**
 * Same search as `serpApi`, but asking for SerpApi's Markdown output
 * (`output=md`). Returns the Markdown text, front matter included.
 *
 * NOTE: the `serpapi` SDK (2.x) only exposes `getJson` and `getHtml`, so
 *       this goes straight to the search endpoint with the same parameters
 *       the SDK would send.
 */
async function serpApiMarkdown(
  params: Record<string, unknown>
): Promise<string> {
  const url = new URL(SERPAPI_SEARCH_URL)
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      url.searchParams.set(key, String(value))
    }
  }
  url.searchParams.set("output", "md")
  url.searchParams.set("api_key", serpApiKey())
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(SERPAPI_TIMEOUT_MS),
    })
    if (!res.ok) {
      // SerpApi reports failures as a JSON body with an `error` string, on
      // Markdown requests too. Surface that text; fall back to the status.
      const body = await res.text().catch(() => "")
      const detail = body ? serpApiErrorText(body) : `HTTP ${res.status}`
      throw new SerpApiError(
        `SerpApi request failed: ${detail}`,
        serpApiHint(detail),
        res.status
      )
    }
    return await res.text()
  } catch (err) {
    throw toSerpApiError(err)
  }
}

/**
 * Split SerpApi's Markdown output into its YAML front matter and body.
 * The front matter carries `search_metadata` (with the live SERP URL the
 * Sources panel links to); the body is what the model reads.
 *
 * Pure and exported so the parsing can be tested against saved samples.
 */
export function splitMarkdownFrontMatter(markdown: string): {
  searchUrl: string | null
  body: string
} {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { searchUrl: null, body: markdown.trim() }
  const frontMatter = match[1]
  // Any `<engine>_url` key under search_metadata, e.g. `google_finance_url`.
  const urlMatch = frontMatter.match(/^\s*google\w*_url:\s*"?([^"\r\n]+)"?/m)
  return {
    searchUrl: urlMatch ? urlMatch[1].trim() : null,
    body: markdown.slice(match[0].length).trim(),
  }
}

// NOTE: executor arg types are inferred from the Zod schemas above. By
//       the time you reach an executor, `validateToolArgs` has already
//       parsed and narrowed the input. The casts in `TOOL_EXECUTORS`
//       below are the single source of that truth.
type GoogleSearchArgs = z.infer<typeof googleSearchArgs>
type GoogleFinanceArgs = z.infer<typeof googleFinanceArgs>
type GoogleNewsArgs = z.infer<typeof googleNewsArgs>
type GoogleMapsArgs = z.infer<typeof googleMapsArgs>
type GoogleFlightsArgs = z.infer<typeof googleFlightsArgs>
type GoogleHotelsArgs = z.infer<typeof googleHotelsArgs>
type GoogleShoppingArgs = z.infer<typeof googleShoppingArgs>

// WHY: SerpApi rejects regional codes like "eu", "apac", "latam" as `gl`
//      even though models love producing them. Dropping anything that isn't
//      a plausible 2-letter ISO country code turns a stray `gl: "eu"` into
//      a no-op instead of a 4xx.
const REGIONAL_BLOCS = new Set([
  "eu",
  "ww",
  "intl",
  "apac",
  "emea",
  "latam",
  "mena",
])

/**
 * Normalize a `gl` country code: lowercased, two letters, no regional bloc.
 * Returns `undefined` for any input that wouldn't be safe to send to SerpApi.
 */
export function normalizeCountryCode(
  code: string | undefined
): string | undefined {
  if (!code) return undefined
  const lower = code.toLowerCase().trim()
  if (!/^[a-z]{2}$/.test(lower)) return undefined
  if (REGIONAL_BLOCS.has(lower)) return undefined
  return lower
}

/**
 * Normalize an `hl` language code: lowercased and two letters, otherwise
 * `undefined`. SerpApi accepts most ISO 639-1 codes verbatim.
 */
function normalizeLanguageCode(code: string | undefined): string | undefined {
  if (!code) return undefined
  const lower = code.toLowerCase().trim()
  return /^[a-z]{2}$/.test(lower) ? lower : undefined
}

// ─── Executors ─────────────────────────────────────────
// `toolParams` maps each tool to its SerpApi request parameters, one
// switch, so you can see every tool's call shape in one place.
// `executeTool` runs that call with the matching `json_restrictor`
// (the server-side field selection from https://serpapi.com/json-restrictor),
// so the response arrives pre-trimmed to the fields the model needs and
// no client-side formatting is required. `executeToolUnrestricted` runs
// the identical call WITHOUT the restrictor. It backs the optional
// "compare the full response" view, the only place the untrimmed payload
// is ever fetched.

/**
 * Build the SerpApi request parameters for a tool call, excluding the
 * restrictor. Shared by the live executor and the compare endpoint so
 * both hit SerpApi with identical parameters apart from `json_restrictor`.
 */
export function toolParams(
  name: RestrictorTool,
  args: ToolArgs
): Record<string, unknown> {
  switch (name) {
    case "google_search": {
      const a = args as GoogleSearchArgs
      const gl = normalizeCountryCode(a.gl)
      const hl = normalizeLanguageCode(a.hl)
      return {
        engine: "google",
        q: a.query,
        num: a.num ?? 5,
        ...(gl ? { gl } : {}),
        ...(hl ? { hl } : {}),
      }
    }
    case "google_finance_search": {
      const a = args as GoogleFinanceArgs
      const hl = normalizeLanguageCode(a.hl)
      return {
        engine: "google_finance",
        q: a.query,
        ...(hl ? { hl } : {}),
        ...(a.window ? { window: a.window } : {}),
      }
    }
    case "google_news_search": {
      const a = args as GoogleNewsArgs
      const gl = normalizeCountryCode(a.gl)
      const hl = normalizeLanguageCode(a.hl)
      return {
        engine: "google_news",
        q: a.query,
        ...(gl ? { gl } : {}),
        ...(hl ? { hl } : {}),
      }
    }
    case "google_maps_search": {
      const a = args as GoogleMapsArgs
      const gl = normalizeCountryCode(a.gl)
      const hl = normalizeLanguageCode(a.hl)
      return {
        engine: "google_maps",
        q: a.query,
        type: "search",
        ...(gl ? { gl } : {}),
        ...(hl ? { hl } : {}),
      }
    }
    case "google_flights_search": {
      const a = args as GoogleFlightsArgs
      const hl = normalizeLanguageCode(a.hl)
      // WHY: models sometimes claim a round trip (`type: "1"`) without
      //      providing a return date, which SerpApi rejects with a 400.
      //      The return date is the source of truth: present → round
      //      trip, absent → one-way, whatever the model said.
      const type = a.return_date ? "1" : "2"
      return {
        engine: "google_flights",
        // SerpApi takes several airports as "EZE,AEP", without spaces.
        departure_id: a.departure_id.replace(/\s+/g, ""),
        arrival_id: a.arrival_id.replace(/\s+/g, ""),
        outbound_date: a.outbound_date,
        type,
        currency: a.currency ?? "USD",
        ...(a.return_date ? { return_date: a.return_date } : {}),
        ...(hl ? { hl } : {}),
        ...(a.travel_class ? { travel_class: a.travel_class } : {}),
      }
    }
    case "google_hotels_search": {
      const a = args as GoogleHotelsArgs
      const gl = normalizeCountryCode(a.gl)
      const hl = normalizeLanguageCode(a.hl)
      return {
        engine: "google_hotels",
        q: a.query,
        check_in_date: a.check_in_date,
        check_out_date: a.check_out_date,
        adults: a.adults ?? 2,
        currency: a.currency ?? "USD",
        ...(gl ? { gl } : {}),
        ...(hl ? { hl } : {}),
      }
    }
    case "google_shopping_search": {
      const a = args as GoogleShoppingArgs
      const gl = normalizeCountryCode(a.gl)
      const hl = normalizeLanguageCode(a.hl)
      return {
        engine: "google_shopping",
        q: a.query,
        ...(gl ? { gl } : {}),
        ...(hl ? { hl } : {}),
      }
    }
  }
}

/**
 * What one SerpApi tool call hands back to the agent loop.
 *
 * `payload` is exactly what the model receives as the tool result: a JSON
 * tree in `json` mode, a Markdown string in `markdown` mode. `searchUrl`
 * is the live SERP link, lifted out of `search_metadata` so the Sources
 * panel can show it without the model ever seeing it.
 */
type ToolResult = {
  payload: JsonValue
  searchUrl: string | null
}

/**
 * Run a tool's SerpApi call in the requested output mode. Pass
 * `restricted: false` for the full, untrimmed response the compare view
 * shows; the chat loop runs restricted unless the output mode opts out.
 *
 * WHY: `createServerOnlyFn`, not a plain export, like `runAgentTurn`. A
 *      plain export keeps everything it references in the client module
 *      graph, the `serpapi` SDK included. Wrapped, the client build drops
 *      the body and the SDK import with it.
 */
export const executeTool = createServerOnlyFn(
  async (
    name: RestrictorTool,
    args: ToolArgs,
    output: ToolOutput,
    restricted = true
  ): Promise<ToolResult> => {
    const restrictor = restricted ? restrictorFor(name, output) : null
    const params: Record<string, unknown> = {
      ...toolParams(name, args),
      ...(restrictor ? { json_restrictor: restrictor } : {}),
    }
    try {
      return await executeWithParams(params, output)
    } catch (err) {
      // WHY: models carry the user's country into every search, and some
      //      engines refuse some countries (Google Shopping rejects `uy`).
      //      One retry without the refused parameter answers the question.
      if (!(err instanceof SerpApiError)) throw err
      // WHY: one search in the real-usage test came back HTTP 503 and the
      //      next one worked. A single retry hides that from the user.
      if (isTransientSerpApiError(err.message, err.status)) {
        return executeWithParams(params, output)
      }
      const param = unsupportedParam(err.message)
      if (!param || !(param in params)) throw err
      const retry = { ...params }
      delete retry[param]
      return executeWithParams(retry, output)
    }
  }
)

async function executeWithParams(
  params: Record<string, unknown>,
  output: ToolOutput
): Promise<ToolResult> {
  if (output !== "json") {
    const { searchUrl, body } = splitMarkdownFrontMatter(
      await serpApiMarkdown(params)
    )
    return { payload: body, searchUrl }
  }
  const json = await serpApi(params)
  const searchUrl = extractSearchUrl(json)
  if (json && typeof json === "object") delete json.search_metadata
  return { payload: json as JsonValue, searchUrl }
}

/**
 * Detect a Google Finance response that carries no usable quote. When
 * SerpApi has nothing for a symbol the restricted response is missing
 * both `summary.title` and `summary.price` and ships an empty
 * `knowledge_graph.key_stats.stats` array. The agent loop uses this
 * signal to pivot to `google_search` instead of handing the model a
 * blank object.
 */
export function isEmptyFinanceResponse(response: SerpApiJson): boolean {
  // Markdown mode: SerpApi renders an empty quote as headings with nothing
  // under them, so look for the price line the restrictor keeps.
  if (typeof response === "string") {
    return !/^- (Price|Extracted Price):/m.test(response)
  }
  const summary = response?.summary
  if (summary?.title || summary?.price) return false
  const stats = response?.knowledge_graph?.key_stats?.stats
  if (Array.isArray(stats) && stats.length > 0) return false
  const news = response?.news_results
  if (Array.isArray(news) && news.length > 0) return false
  return true
}

/**
 * Sum per-completion usage into one turn total. Returns `null` if any
 * completion lacked usage: an incomplete total is worse than no total,
 * because a benchmark reader would take the smaller number at face value.
 */
export function sumUsage(
  usages: Array<LmStudioUsage | null | undefined>
): (ExactUsage & { completions: number }) | null {
  if (usages.length === 0) return null
  const acc = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }
  let reasoning: number | undefined = 0
  for (const u of usages) {
    if (!u) return null
    acc.promptTokens += u.prompt_tokens
    acc.completionTokens += u.completion_tokens
    acc.totalTokens += u.total_tokens
    const r = u.completion_tokens_details?.reasoning_tokens
    // One call without the figure makes the sum unknown, not smaller.
    reasoning =
      reasoning === undefined || typeof r !== "number"
        ? undefined
        : reasoning + r
  }
  return {
    ...acc,
    ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    completions: usages.length,
  }
}

/** The `usage` block of an LM Studio chat completion. */
type LmStudioUsage = {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  completion_tokens_details?: { reasoning_tokens?: number } | null
}

/** One completion's usage in the app's shape. Exported for tests. */
export function toExactUsage(usage: LmStudioUsage): ExactUsage {
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    ...(typeof reasoning === "number" ? { reasoningTokens: reasoning } : {}),
  }
}

export type RunQueryResult = {
  // WHY: false when the turn produced no fresh metrics (an error, or the
  //      non-tool-model fast path). The client keeps the previous sidebar
  //      state instead of overwriting it with this result's zeros.
  ok: boolean
  answer: string
  breakdown: Breakdown
  // Usage LM Studio reported for the FINAL completion of the turn (the
  // answer call, or the only call on a direct answer). Its prompt count is
  // the context the model actually processed to write the answer.
  exactUsage: ExactUsage | null
  // WHY: the sum of every completion's usage this turn (tool pick + answer
  //      + any retry). This is the workload total a benchmark should
  //      compare, distinct from the final-call snapshot above. `null` when
  //      any completion came back without usage, so an unknown never reads
  //      as zero. `completions` is how many calls contributed.
  totalUsage: (ExactUsage & { completions: number }) | null
  // WHY: one entry per tool the model invoked. Empty array means the
  //      model answered directly. Multiple entries happen on parallel
  //      tool calls, the same shape OpenAI and Anthropic give you.
  toolCalls: Array<ToolCallInfo>
  sources: Array<Source>
  elapsedMs: number
  phases: Phases
  // WHY: ship the conversation back to the client (sans system prompt)
  //      so the next `runQuery` can resend it as `history`. You rebuild
  //      the system prompt on every call so it always reflects today's
  //      date. Sending it over the wire would just go stale.
  messages: Array<ChatCompletionMessageParam>
  // NOTE: how many old turns you had to drop to fit inside the model's
  //       context budget. Zero most of the time; surfaces in the UI as
  //       a hint when the conversation starts eating into the sliding
  //       window.
  trimmedTurns: number
  // NOTE: total tokens the conversation occupies right now (tool defs +
  //       system prompt + sanitised history). Powers the "Context used"
  //       hero in the UI, the same number you'd see in LM Studio's own
  //       conversation-tokens counter.
  conversationTokens: number
  // NOTE: the context window LM Studio ACTUALLY loaded for this turn, after
  //       the back-off probe. May be smaller than the size the client asked
  //       for if the machine couldn't fit it. Null when no load was needed
  //       (e.g. LM Studio unreachable). The UI shows this as the real
  //       denominator instead of the optimistic starting guess.
  loadedContext: number | null
  // The context LM Studio says it applied, when it said. Larger than
  // `loadedContext` on MLX, where the engine fits the window to memory.
  appliedContext: number | null
  // True when the answer call came back empty and was asked again.
  retried: boolean
  // The last completion stopped at `MAX_COMPLETION_TOKENS`.
  cutOff: boolean
  // Tool rounds in the turn: 0 for a direct answer, up to 3 when the
  // model searched again after reading the results.
  toolRounds: number
  // The model's last raw reply when the turn ends without an answer, so
  // the UI can show what it wrote (often another tool call) instead of a
  // generic error. Null when the turn produced an answer.
  rawReply: string | null
  // True when the answer call and its retry both came back empty, so
  // `answer` holds the fallback notice instead of a model answer. A
  // benchmark must treat this as a failed turn, not a completed one.
  answerMissing: boolean
}

// ─── System prompt ─────────────────────────────────────
// Rebuilt on every call so today's date is always current. Keeping it
// as a plain template literal beats moving it to a separate file: when
// you're tracing a tool call you can read the rules right here without
// jumping to another module.

/**
 * Build the system prompt for the current call. Embeds today's date and
 * the rules the model should follow.
 */
export function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10)
  return `You are a research assistant with access to real-time web search.
Today's date is ${today}.

You have seven tools:
- google_search: Google web search (general knowledge, current events).
- google_finance_search: Real-time stocks, currencies, indices.
- google_news_search: Breaking news with source and date.
- google_maps_search: Local businesses and places with rating and address.
- google_flights_search: Flight prices between two IATA-coded airports.
- google_hotels_search: Hotel and vacation-rental prices for a location and date range.
- google_shopping_search: Product listings with price, seller, and rating.

Rules:
- Use a tool whenever the question requires current information.
- Time-sensitive queries (flight prices, stock prices, news, weather, sports scores, business hours) MUST trigger a fresh tool call every turn. NEVER replay a prior answer from conversation history, even if the question is identical. Stale prices and outdated news are worse than a slightly slower answer.
- Earlier answers marked "Earlier answer, written from a live search" are there so you know what the user means by "those", "that hotel" or "the plan". Use them for references, comparisons between earlier results and summaries of the conversation.
- Answer in the language the user wrote the question in, even when you searched in another language.
- When the user asks about multiple entities (compare X and Y, prices of A, B, C), request ALL tool calls in the same turn, one call per entity, instead of chaining them.
- For flights, hotels, maps, and shopping, render the results as a compact markdown table directly from the tool response: one row per item, with the most useful columns first (name, price/rating, key detail). Add one short summary line afterward (cheapest / top pick).
- For flights, always use IATA codes (e.g. SCL, MAD, JFK, LAX).
- For hotels, check_in_date and check_out_date are required (YYYY-MM-DD). If the user gives no dates, pick a reasonable near-future range based on today's date and state which dates you assumed.
- For google_news_search, pass the topic ONLY in \`query\`. Never include words like "news", "latest", "últimas". The tool already sorts by recency.
- Localization: when the user writes in a language other than English, set \`hl\` (language code like "es") on every tool that supports it, and \`gl\` (country code like "cl", "es", "mx") on tools that support it. Every tool takes \`hl\`; every tool except finance and flights also takes \`gl\`.
- \`gl\` is ALWAYS a single country (ISO 3166-1 alpha-2: us, gb, de, fr, jp, mx, cl, ...). It is NEVER a region. Do not use "eu", "apac", "latam", "emea". If the topic is a region (e.g. "EU AI Act", "European elections", "Asian markets"), either omit \`gl\` or pick one representative country (e.g. "gb" or "de" for European topics).
- If google_news_search returns an empty result set, immediately call google_search with the same topic before giving up. Some subjects (niche tech, B2B products, internal tooling) have no dedicated news coverage but plenty of general web results.
- Cite sources as markdown links: [name](url). Never write a plain-text source line like "Source: NASDAQ"; every search you run is listed automatically in a Sources panel under your answer.
- Do not invent or assume dates. Report only what the results say.
- After receiving tool results, answer from them in prose. If they missed the question (unrelated pages, the wrong entity), you may search again with a better query. Do not search again to double-check an answer the results already give.
- If the results still do not match the question exactly (a different product model, unrelated pages), answer with the closest results and say what was missing.
- Keep answers short. Answer the question directly in the first sentence, then add only the details the question asked for. No preamble, no headings, no closing summary, no follow-up offers. A table (when the rules above call for one) plus one or two sentences is a complete answer. Do not mirror the structure or length of the tool result.
`
}

// ─── Sources & telemetry ───────────────────────────────
// Helpers that turn raw SerpApi metadata and the final answer into the
// "Sources" panel and the on-disk benchmark log.

/**
 * Pull the original SerpApi search URL from the response metadata. Lets
 * the UI link straight from a citation in the assistant's answer to the
 * full SERP on SerpApi.
 */
function extractSearchUrl(raw: SerpApiJson): string | null {
  const meta = raw?.search_metadata ?? {}
  for (const key of [
    "google_url",
    "google_finance_url",
    "google_news_url",
    "google_maps_url",
    "google_flights_url",
    "google_hotels_url",
    "google_shopping_url",
  ]) {
    if (typeof meta[key] === "string") return meta[key]
  }
  return null
}

/**
 * Short human label per tool call. Lets you tell two parallel calls
 * apart in the Sources panel (e.g. AAPL vs TSLA in a "compare" query).
 */
function toolCallLabel(tc: ToolCallInfo): string {
  const a = tc.args
  switch (tc.name) {
    case "google_search":
      return `Search · ${a.query ?? ""}`
    case "google_finance_search":
      return `Finance · ${a.query ?? ""}`
    case "google_news_search":
      return `News · ${a.query ?? ""}`
    case "google_maps_search":
      return `Maps · ${a.query ?? ""}`
    case "google_flights_search":
      return `Flights · ${a.departure_id ?? "?"} → ${a.arrival_id ?? "?"}`
    case "google_hotels_search":
      return `Hotels · ${a.query ?? ""}`
    case "google_shopping_search":
      return `Shopping · ${a.query ?? ""}`
    default:
      return tc.name
  }
}

/**
 * Build the Sources list from tool URLs and any markdown links the model
 * embedded in the answer.
 *
 * WHY: prepend one entry per tool call (in invocation order) so you can
 *      trace each claim back to the exact SERP that produced it,
 *      especially important on parallel tool calls where multiple SERPs
 *      sit behind a single answer.
 */
export function extractSources(
  finalText: string,
  toolSources: Array<{ url: string; label: string }>
): Array<Source> {
  const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g
  const seen = new Set<string>()
  const sources: Array<Source> = []

  for (const ts of toolSources) {
    if (!seen.has(ts.url)) {
      seen.add(ts.url)
      sources.push({ label: ts.label, url: ts.url })
    }
  }

  for (const match of finalText.matchAll(linkRegex)) {
    const [, label, url] = match
    if (!seen.has(url)) {
      seen.add(url)
      sources.push({ label, url })
    }
  }

  return sources
}

/**
 * Strip likely secrets before writing a query to the benchmark log.
 *
 * WHY: the log is gitignored, but you'll end up sharing it manually
 *      (screenshots, blog comments, pasted into issues). Defensive
 *      redaction keeps an accidental paste from leaking your keys.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[redacted-sk-key]")
    .replace(/\b[0-9a-f]{32,}\b/gi, "[redacted-hex-key]")
    .replace(
      /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      "[redacted-email]"
    )
}

// NOTE: the shape of an entry in `measurements/benchmark_log.json`. The
//       later fields (timestamp, exact_usage, sources_count, phases) were
//       added without changing the earlier ones, so old logs still read.
type BenchmarkEntry = {
  timestamp: string
  query: string
  model: string
  tool_called: string | null
  tools_called: Array<string>
  tokens: {
    tool_definitions: number
    system_prompt: number
    user_message: number
    tool_call: number
    tool_result: number
    final_response: number
    total: number
  }
  exact_usage: ExactUsage | null
  sources_count: number
  time_seconds: number
  phases: Phases
  success: boolean
  response: string
}

const BENCHMARK_LOG_PATH = "measurements/benchmark_log.json"

/**
 * Append-only query log for local measurement, kept as one JSON array.
 * Development only: a production server has no reason to keep a record of
 * the questions it was asked.
 *
 * WHY: writes are chained, because a chat turn and a benchmark cell can
 *      finish together and the second write would drop the first entry.
 *      A logging failure must never break the user-facing query.
 */
function appendBenchmarkLog(entry: BenchmarkEntry): Promise<void> {
  if (!import.meta.env.DEV) return Promise.resolve()
  const write = lifecycle.logWrite.then(() => writeBenchmarkLog(entry))
  lifecycle.logWrite = write
  return write
}

async function writeBenchmarkLog(entry: BenchmarkEntry): Promise<void> {
  try {
    await mkdir(dirname(BENCHMARK_LOG_PATH), { recursive: true })
    let existing: Array<unknown> = []
    let raw: string | null = null
    try {
      raw = await readFile(BENCHMARK_LOG_PATH, "utf-8")
    } catch (err) {
      if (!(err instanceof Error && "code" in err && err.code === "ENOENT")) {
        throw err
      }
    }
    if (raw !== null) {
      const parsed = safeJsonParse(raw)
      if (Array.isArray(parsed)) {
        existing = parsed
      } else {
        // Keep an unreadable log instead of overwriting it with one entry.
        await rename(
          BENCHMARK_LOG_PATH,
          `${BENCHMARK_LOG_PATH}.unreadable-${Date.now()}`
        )
      }
    }
    existing.push(entry)
    const tmp = `${BENCHMARK_LOG_PATH}.tmp`
    await writeFile(tmp, JSON.stringify(existing, null, 2), "utf-8")
    await rename(tmp, BENCHMARK_LOG_PATH)
  } catch (err) {
    console.error("[benchmark-log] failed to append entry:", err)
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

// ─── Model loading ─────────────────────────────────────
// LM Studio's native API exposes the model list plus a load/unload pair.
// You use both: one to populate the dropdown with metadata, the other to
// reload a running model when the user picks a different context size.

// ─── Context sizing ────────────────────────────────────
// You can't predict, from this server, how much memory a model will take,
// it depends on the OS, the quantization, and (on a PC) how much VRAM the
// GPU has versus system RAM. So you don't try. LM Studio ships a memory
// guardrail that estimates the fit (context length + flash attention +
// vision) and BLOCKS a load that won't fit, on REST loads too. You let that
// guardrail be the judge: pick an optimistic starting size, attempt the
// load, and if it's blocked, back off and try smaller. Same code path works
// on a unified-memory Mac and a Windows/Linux box with a discrete GPU.

// Smallest context worth loading. Below this a tool call plus its result
// won't fit, so there's no point shrinking further.
const MIN_CONTEXT = 4096
// Round every context size down to this multiple so loaded values read
// cleanly (and the back-off lands on sensible numbers).
const CONTEXT_STEP = 1024
// Optimistic default start for the load probe: a generous 32K window (4×
// LM Studio's 8K default, plenty for long conversations) that fits the
// common 4–27B models on a 36 GB-class machine. The back-off shrinks it on
// tighter hardware; `LMSTUDIO_CONTEXT_LENGTH` raises it on roomier ones.
const DEFAULT_CONTEXT_CAP = 32768

/**
 * Optimistic STARTING context size for the load probe: the generous default
 * cap, clamped to the model's native max. The back-off in `ensureModelLoaded`
 * shrinks this until LM Studio's guardrail accepts it, so it's a ceiling,
 * not a promise, which is why it no longer guesses from param count.
 */
export function recommendedContext(maxContextLength: number): number {
  return Math.min(DEFAULT_CONTEXT_CAP, maxContextLength)
}

/**
 * Hard override for the loaded context size. Set `LMSTUDIO_CONTEXT_LENGTH`
 * to pin a value and skip the back-off probe. Handy when you know exactly
 * what your machine fits. Ignored if unset or below `MIN_CONTEXT`.
 */
export function contextOverride(): number | null {
  const raw = Number(process.env.LMSTUDIO_CONTEXT_LENGTH)
  return Number.isFinite(raw) && raw >= MIN_CONTEXT
    ? Math.floor(raw / CONTEXT_STEP) * CONTEXT_STEP
    : null
}

/**
 * The sizes the load probe will try, largest first: `start`, then 3/4, 1/2,
 * 3/8, 1/4 and 1/8 of it, each floored to a clean step, ending on
 * `MIN_CONTEXT`. Pure and exported so the schedule can be tested without a
 * live LM Studio.
 *
 * WHY: quarter steps, not halving. A refused load comes back in under a
 *      tenth of a second, so extra steps cost nothing, and they land closer
 *      to what fits: on a 36 GB Mac, Gemma 4 31B fits at 36,864 but not
 *      40,960, and halving from 49,152 would have dropped to 24,576.
 */
export function contextBackoffSequence(start: number): Array<number> {
  if (start < MIN_CONTEXT) return []
  const seq: Array<number> = []
  for (const fraction of [1, 0.75, 0.5, 0.375, 0.25, 0.125]) {
    const ctx = Math.floor((start * fraction) / CONTEXT_STEP) * CONTEXT_STEP
    if (ctx >= MIN_CONTEXT && !seq.includes(ctx)) seq.push(ctx)
  }
  if (!seq.includes(MIN_CONTEXT)) seq.push(MIN_CONTEXT)
  return seq
}

/**
 * Every currently-loaded model instance across LM Studio, each as
 * `{ id, model, ctx }`. Empty array if nothing's loaded or LM Studio is
 * unreachable. Never throws.
 */
async function allLoadedInstances(): Promise<
  Array<{ id: string; model: string; type: string; ctx: number }>
> {
  try {
    const res = await fetch(`${lmStudioNativeUrl()}/models`, {
      headers: lmStudioHeaders(),
      signal: AbortSignal.timeout(LM_STUDIO_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return []
    const models = parseLmStudioModels(await res.json()) ?? []
    return uniqueInstances(
      models.flatMap((m) =>
        m.loaded_instances.map((i) => ({
          id: i.id,
          model: m.key,
          type: m.type,
          ctx: i.config.context_length,
        }))
      )
    )
  } catch {
    return []
  }
}

// What this process last loaded each model with: the start size the caller
// asked for, and the context that loaded. Cleared when the model is unloaded,
// so a model loaded by hand in LM Studio is reloaded once at our size and
// then reused.
type LoadRecord = { target: number; loaded: LoadedContext }

// WHY: model state lives on `globalThis`, not in module scope. HMR swaps
//      this module mid-query, and a fresh copy would lose the in-flight
//      count and the idle timer, which could then unload the model under a
//      running turn. Same pattern as the chat sessions and benchmark job.
type Lifecycle = {
  loadedByUs: Map<string, LoadRecord>
  idleUnloadTimer: ReturnType<typeof setTimeout> | null
  // Queries in flight, per model.
  inFlight: Map<string, number>
  queryProgress: Map<string, QueryProgress>
  // The last benchmark-log write, so the next one waits for it.
  logWrite: Promise<void>
}
const lifecycle = ((
  globalThis as typeof globalThis & { __agentLifecycle?: Lifecycle }
).__agentLifecycle ??= {
  loadedByUs: new Map(),
  idleUnloadTimer: null,
  inFlight: new Map(),
  queryProgress: new Map(),
  logWrite: Promise.resolve(),
})
const loadedByUs = lifecycle.loadedByUs

/**
 * A model's context as loaded. `applied` is what LM Studio reports it set
 * up, or null when it did not say. On GGUF the two match. On MLX they do
 * not: the engine sizes the window from free memory and keeps the larger
 * value (asked for 32,768, it applied 61,696 on a 36 GB Mac and 119,552 on
 * a 48 GB one).
 */
export type LoadedContext = { requested: number; applied: number | null }

/**
 * Drop repeated instance ids. With LM Link on, `/api/v1/models` lists a
 * model once per linked device that has it, so one loaded instance shows up
 * twice. Treating those as duplicates made `ensureModelLoaded` unload and
 * reload the model before every query.
 */
export function uniqueInstances<T extends { id: string }>(
  instances: Array<T>
): Array<T> {
  const seen = new Set<string>()
  return instances.filter((i) => {
    if (seen.has(i.id)) return false
    seen.add(i.id)
    return true
  })
}

/**
 * The loaded instances to unload before loading `model`: every other LLM.
 * Embedding models stay loaded; they are small, and another app may be
 * using one. Exported for tests.
 */
export function instancesToFree<T extends { model: string; type: string }>(
  all: Array<T>,
  model: string
): Array<T> {
  return all.filter((i) => i.model !== model && i.type === "llm")
}

/**
 * Unload one instance by id. Best-effort: a failure just means the next
 * load may spin up alongside it, which `ensureModelLoaded` re-checks.
 */
async function unloadInstance(id: string): Promise<void> {
  // Instance ids are model keys unless LM Studio runs duplicates
  // (`key:2`), so this forgets the size for the model being unloaded.
  loadedByUs.delete(id.replace(/:\d+$/, ""))
  try {
    await fetch(`${lmStudioNativeUrl()}/models/unload`, {
      method: "POST",
      headers: lmStudioHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ instance_id: id }),
      signal: AbortSignal.timeout(LM_STUDIO_FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    devWarn(`[unloadInstance] ${id} failed, continuing:`, err)
  }
}

/** The outcome of one load attempt. */
export type LoadAttempt =
  | { kind: "loaded"; applied: number | null }
  // LM Studio's memory guardrail said no. Try a smaller size.
  | { kind: "refused"; message: string }
  // Anything else: unknown model, engine error, LM Link drop. Retrying at a
  // smaller size would not help and would hide the real cause.
  | { kind: "failed"; message: string }

/**
 * Sort a `POST /api/v1/models/load` response into an outcome. Exported for
 * tests.
 *
 * NOTE: a guardrail refusal and an engine failure share the same error type
 *       (`model_load_failed`, HTTP 500); only the message tells them apart.
 *       The refusal says "insufficient system resources" and arrives in
 *       well under a second, before any weights are read.
 */
export function classifyLoadResponse(
  status: number,
  body: unknown
): LoadAttempt {
  if (status >= 200 && status < 300) {
    const parsed = loadSuccessSchema.safeParse(body)
    return {
      kind: "loaded",
      applied: parsed.success
        ? (parsed.data.load_config?.context_length ?? null)
        : null,
    }
  }
  const parsed = loadErrorSchema.safeParse(body)
  const message = parsed.success
    ? typeof parsed.data.error === "string"
      ? parsed.data.error
      : parsed.data.error.message
    : `LM Studio returned HTTP ${status}.`
  return /insufficient system resources/i.test(message)
    ? { kind: "refused", message }
    : { kind: "failed", message }
}

const loadSuccessSchema = z.object({
  load_config: z
    .object({ context_length: z.number().int().positive().optional() })
    .optional(),
})

const loadErrorSchema = z.object({
  error: z.union([z.string(), z.object({ message: z.string() })]),
})

/**
 * One load attempt at a specific size. Never throws: a timeout or a
 * dropped connection comes back as `failed`.
 *
 * NOTE: `echo_load_config` makes LM Studio return the config it applied,
 *       which is the only way to learn the real window on MLX. The body
 *       carries ONLY keys this endpoint accepts: `ttl` is rejected with a
 *       400, which would silently fail every load. Idle auto-unload is
 *       therefore handled app-side in `armIdleUnload`, not via a load `ttl`.
 */
async function tryLoadModel(
  model: string,
  contextLength: number
): Promise<LoadAttempt> {
  try {
    const res = await fetch(`${lmStudioNativeUrl()}/models/load`, {
      method: "POST",
      headers: lmStudioHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        model,
        context_length: contextLength,
        flash_attention: true,
        echo_load_config: true,
      }),
      signal: AbortSignal.timeout(LM_STUDIO_LOAD_TIMEOUT_MS),
    })
    const text = await res.text()
    let body: unknown = text
    try {
      body = JSON.parse(text)
    } catch {
      // Not JSON: classify on the status alone.
    }
    const attempt = classifyLoadResponse(res.status, body)
    if (attempt.kind !== "loaded") {
      devWarn(
        `[tryLoadModel] ${model}@${contextLength} ${attempt.kind}:`,
        attempt.message
      )
    }
    return attempt
  } catch (err) {
    return {
      kind: "failed",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * The context to reuse when `model` is already loaded for `target`, or null
 * when it has to be (re)loaded.
 *
 * WHY: compare with the start size the caller asked for, not the size that
 *      loaded. `/api/v1/models` reports the applied context, which on MLX
 *      is the engine's memory fit (61,696 or 119,552), and after a step-down
 *      the caller still asks for 32,768. Comparing either with the loaded
 *      size unloaded and reloaded the model before every query.
 */
export function reusableLoad(
  record: LoadRecord | undefined,
  instances: Array<{ ctx: number }>,
  target: number
): LoadedContext | null {
  if (instances.length !== 1) return null
  if (record?.target === target) return record.loaded
  if (instances[0].ctx === target) return { requested: target, applied: target }
  return null
}

/**
 * Load `model` at a context size that actually fits THIS machine. Strategy:
 * try the requested size; if LM Studio's memory guardrail refuses it, step
 * down (see `contextBackoffSequence`) to `MIN_CONTEXT`. The platform's own
 * estimator is the source of truth, so this is correct on Mac (unified
 * memory) and Windows/Linux (discrete-GPU VRAM) alike.
 *
 * Returns what was asked for and what LM Studio applied. Throws an
 * `LmStudioError` with LM Studio's own message when the load fails for any
 * reason other than size, or when even the smallest size is refused.
 *
 * NOTE: set `LMSTUDIO_CONTEXT_LENGTH` to pin a size and skip the probe.
 */
async function ensureModelLoaded(
  model: string,
  contextLength: number
): Promise<LoadedContext> {
  const override = contextOverride()
  const target = override ?? contextLength

  const all = await allLoadedInstances()
  const targetInstances = all.filter((i) => i.model === model)
  // WHY: this is a one-model-at-a-time chat demo, so free every OTHER LLM
  //      before loading the selected one. Dedicating memory to the active
  //      model gives the guardrail its full budget. Otherwise a model you
  //      tried earlier sits resident and squeezes the new one's context.
  for (const o of instancesToFree(all, model)) await unloadInstance(o.id)

  const reusable = reusableLoad(loadedByUs.get(model), targetInstances, target)
  if (reusable) return reusable
  // Otherwise start clean: loading without unloading spins up a SECOND
  // instance (LM Studio allows duplicates), so clear stale/duplicate target
  // instances first: `/models/load` won't swap a differently-configured one.
  for (const t of targetInstances) await unloadInstance(t.id)
  loadedByUs.delete(model)

  // An explicit override means "use exactly this": one attempt, no back-off.
  const sizes = override !== null ? [override] : contextBackoffSequence(target)
  let lastRefusal: string | null = null
  for (const ctx of sizes) {
    const attempt = await tryLoadModel(model, ctx)
    if (attempt.kind === "loaded") {
      const loaded = { requested: ctx, applied: attempt.applied }
      loadedByUs.set(model, { target, loaded })
      return loaded
    }
    if (attempt.kind === "failed") {
      throw new LmStudioError(
        `LM Studio could not load ${model}: ${attempt.message}`,
        answerCallHint(attempt.message).startsWith("LM Studio lost")
          ? answerCallHint(attempt.message)
          : "Check that the model is downloaded and loads in LM Studio itself, then try again."
      )
    }
    lastRefusal = attempt.message
  }
  throw new LmStudioError(
    `LM Studio would not load ${model} at ${override !== null ? `the pinned ${override.toLocaleString("en-US")} tokens` : `any size down to ${MIN_CONTEXT.toLocaleString("en-US")} tokens`}: ${lastRefusal ?? "no size to try"}`,
    "Close other apps to free memory, pick a smaller model, or adjust the model loading guardrails in LM Studio's settings."
  )
}

function queriesInFlight(): number {
  let n = 0
  for (const count of lifecycle.inFlight.values()) n += count
  return n
}

/** A model another query is using right now, other than `model`, or null. */
function modelInUseOtherThan(model: string): string | null {
  for (const m of lifecycle.inFlight.keys()) if (m !== model) return m
  return null
}

/**
 * Mark the start of a query that keeps `model` resident. Cancels any pending
 * idle unload. Pair with `endQuery` in a `finally` so failures also release.
 */
function beginQuery(model: string): void {
  lifecycle.inFlight.set(model, (lifecycle.inFlight.get(model) ?? 0) + 1)
  if (lifecycle.idleUnloadTimer) {
    clearTimeout(lifecycle.idleUnloadTimer)
    lifecycle.idleUnloadTimer = null
  }
}

/**
 * Mark the end of a query. When it was the last one in flight, (re)arm the
 * idle auto-unload for `model`: once no query arrives for
 * `idleTtlSeconds()` the model is unloaded, and the next query
 * reloads it through the usual back-off probe. This is the app-side stand-in
 * for LM Studio's JIT idle-TTL, which can't apply to a model we loaded
 * explicitly. The countdown only arms with nothing in flight, so it never
 * fires during a slow request. Best-effort: a failed unload just leaves the
 * model resident.
 */
function endQuery(model: string): void {
  const left = (lifecycle.inFlight.get(model) ?? 1) - 1
  if (left > 0) lifecycle.inFlight.set(model, left)
  else lifecycle.inFlight.delete(model)
  if (queriesInFlight() > 0) return
  if (lifecycle.idleUnloadTimer) clearTimeout(lifecycle.idleUnloadTimer)
  const timer = setTimeout(() => {
    lifecycle.idleUnloadTimer = null
    if (queriesInFlight() > 0) return
    void (async () => {
      for (const inst of await allLoadedInstances()) {
        // A query may have started while the list was loading.
        if (queriesInFlight() > 0) return
        if (inst.model === model) await unloadInstance(inst.id)
      }
    })()
  }, idleTtlSeconds() * 1000)
  // Don't let this timer keep the process alive on its own.
  timer.unref()
  lifecycle.idleUnloadTimer = timer
}

const lmStudioModelSchema = z.object({
  key: z.string(),
  display_name: z.string().optional(),
  type: z.string(),
  architecture: z.string().nullable().catch(null),
  params_string: z.string().nullable().catch(null),
  max_context_length: z.number(),
  format: z.enum(["gguf", "mlx"]).nullable().catch(null),
  loaded_instances: z
    .array(
      z.object({
        id: z.string(),
        config: z.object({ context_length: z.number() }),
      })
    )
    .catch([]),
  capabilities: z
    .object({ trained_for_tool_use: z.boolean().optional() })
    .optional()
    .catch(undefined),
})
type LmStudioRawModel = z.infer<typeof lmStudioModelSchema>

/**
 * The models in LM Studio's `/api/v1/models` payload. An entry it can't
 * read is skipped, so one odd model doesn't hide the rest. Null when the
 * payload is not a model list at all. Exported for tests.
 */
export function parseLmStudioModels(
  payload: unknown
): Array<LmStudioRawModel> | null {
  const list = z.object({ models: z.array(z.unknown()) }).safeParse(payload)
  if (!list.success) return null
  return list.data.models.flatMap((m) => {
    const parsed = lmStudioModelSchema.safeParse(m)
    return parsed.success ? [parsed.data] : []
  })
}

/**
 * Every LLM LM Studio knows about, with metadata and a recommended context
 * size. The routes reach it through `listModels` in `models.ts`.
 */
export async function readModels(): Promise<Array<ModelInfo>> {
  let res: Response
  try {
    res = await fetch(`${lmStudioNativeUrl()}/models`, {
      headers: lmStudioHeaders(),
      signal: AbortSignal.timeout(LM_STUDIO_FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new LmStudioError(
      `Can't reach LM Studio at ${lmStudioNativeUrl()}: ${msg}`,
      "Is LM Studio running on localhost:1234? Open it → Developer tab → Start Server."
    )
  }
  if (res.status === 401 || res.status === 403) {
    throw new LmStudioError(
      `LM Studio returned ${res.status} on ${lmStudioNativeUrl()}/models`,
      lmStudioApiKey()
        ? "LM Studio rejected LMSTUDIO_API_KEY. Create a new token on its Developer page and update .env."
        : "LM Studio requires authentication. Create a token on its Developer page, set LMSTUDIO_API_KEY in .env, then restart `bun dev`."
    )
  }
  if (!res.ok) {
    throw new LmStudioError(
      `LM Studio returned ${res.status} on ${lmStudioNativeUrl()}/models`,
      "Restart LM Studio's server (Developer tab → Stop → Start) and try again."
    )
  }
  const models = parseLmStudioModels(await res.json())
  if (!models) {
    throw new LmStudioError(
      `LM Studio returned an unexpected model list from ${lmStudioNativeUrl()}/models.`,
      "Update LM Studio, then restart its server from the Developer tab."
    )
  }
  // WHY: LM Studio sometimes lists the same logical model twice (the
  //      GGUF and MLX variants of one release share the `key`). Dedupe
  //      by key, or the model picker warns about duplicate React keys;
  //      keeping the first entry is fine.
  const seen = new Set<string>()
  return models
    .filter((m) => m.type === "llm")
    .filter((m) => {
      if (seen.has(m.key)) return false
      seen.add(m.key)
      return true
    })
    .map((m): ModelInfo => ({
      id: m.key,
      displayName: m.display_name ?? m.key,
      arch: m.architecture,
      params: m.params_string,
      maxContextLength: m.max_context_length,
      currentContextLength:
        m.loaded_instances[0]?.config.context_length ?? null,
      toolUseTrained: m.capabilities?.trained_for_tool_use ?? false,
      format: m.format,
      recommendedContextLength: recommendedContext(m.max_context_length),
    }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

// ─── Inline tool-call parsing ──────────────────────────
// Many open models emit tool calls as text inside `message.content`
// instead of using the structured `tool_calls` field. LM Studio's
// built-in parser covers the JSON-in-XML shape; the nested-XML shape
// leaks through. You recover both here so the rest of the agent loop can
// treat inline calls identically to native structured ones.

export type InlineToolCall = {
  name: string
  rawArgs: string
  args: Record<string, unknown>
}

/**
 * Parse one `<tool_call>` body into an `InlineToolCall`. Tries
 * JSON-in-XML first, falls back to nested XML. Returns `null` for
 * unparseable input. When that happens the caller logs and moves on
 * so one bad block doesn't take down the whole turn.
 */
function parseSingleInlineToolCall(body: string): InlineToolCall | null {
  const trimmed = body.trim()

  // Shape 1: JSON-in-XML.
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed.name === "string" && parsed.arguments) {
        const args =
          typeof parsed.arguments === "string"
            ? JSON.parse(parsed.arguments)
            : parsed.arguments
        return { name: parsed.name, rawArgs: JSON.stringify(args), args }
      }
    } catch {
      // fall through to nested-XML attempt
    }
  }

  // Shape 2: Nested XML.
  const fn = trimmed.match(/<function=([^>\s]+)>([\s\S]*?)<\/function>/)
  if (fn) {
    const name = fn[1].trim()
    const args: Record<string, unknown> = {}
    for (const pm of fn[2].matchAll(
      /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g
    )) {
      const key = pm[1].trim()
      const rawValue = pm[2].trim()
      if (/^-?\d+$/.test(rawValue)) {
        args[key] = parseInt(rawValue, 10)
      } else if (/^-?\d*\.\d+$/.test(rawValue)) {
        args[key] = parseFloat(rawValue)
      } else {
        // NOTE: strip surrounding quotes if the model wrapped the value.
        args[key] = rawValue.replace(/^["']|["']$/g, "")
      }
    }
    return { name, rawArgs: JSON.stringify(args), args }
  }

  return null
}

/**
 * Gemma 4's own tool-call format: `<|tool_call>call:NAME{key:<|"|>value<|"|>}`,
 * optionally closed by `<tool_call|>`. LM Studio parses it only when tools
 * are attached; on the answer call, which has none, it reached the user as
 * the answer (Gemma 4 12B, 2026-10-02).
 */
function parseGemmaToolCalls(content: string): Array<InlineToolCall> {
  const calls: Array<InlineToolCall> = []
  for (const m of content.matchAll(
    /<\|tool_call>call:([\w.-]+)\{([\s\S]*?)\}(?:<tool_call\|>)?/g
  )) {
    const args: Record<string, unknown> = {}
    for (const pm of m[2].matchAll(
      /(\w+):(?:<\|"\|>([\s\S]*?)<\|"\|>|([^,}]+))/g
    )) {
      const quoted = pm[0].includes('<|"|>')
      const raw = quoted ? pm[2] : pm[3].trim()
      args[pm[1]] = !quoted && /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw
    }
    calls.push({ name: m[1], rawArgs: JSON.stringify(args), args })
  }
  return calls
}

/**
 * Parse every `<tool_call>…</tool_call>` block in a message body into
 * the same shape as OpenAI's structured `tool_calls`. This is what lets
 * you do parallel tool calling on open models that emit calls as text.
 */
export function parseInlineToolCalls(raw: string): Array<InlineToolCall> {
  // A call written only inside the reasoning is not a request to run it.
  const content = raw.replace(/<think>[\s\S]*?<\/think>/gi, "")
  const calls: Array<InlineToolCall> = [...parseGemmaToolCalls(content)]
  for (const match of content.matchAll(
    /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi
  )) {
    const parsed = parseSingleInlineToolCall(match[1])
    if (parsed) {
      calls.push(parsed)
    } else {
      devWarn(
        "[parseInlineToolCalls] unparseable <tool_call> body:",
        match[1].slice(0, 200)
      )
    }
  }
  return calls
}

/** True when a completion's text contains a tool call the model wrote inline. */
export function hasInlineToolCall(content: string): boolean {
  return /<tool_call>|<function=|<\|tool_call>/i.test(
    content.replace(/<think>[\s\S]*?<\/think>/gi, "")
  )
}

/**
 * Strip any `<tool_call>…</tool_call>` fragments, including
 * unterminated ones, from a final answer.
 *
 * WHY: after the second completion you'll occasionally see "I want to
 *      call another tool but I can't" cases where the model emits
 *      trailing XML. Stripping it before showing the answer keeps
 *      parser noise out of the chat.
 */
export function stripInlineToolCalls(content: string): string {
  return (
    content
      // NOTE: thinking models (Qwen 3.x, DeepSeek R1 distills) wrap their
      //       reasoning in <think> tags. LM Studio moves that into
      //       `message.reasoning` when its parser is on; when it's off the
      //       block lands in `content` and would render as literal text.
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/^[\s\S]*?<\/think>/i, "")
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
      .replace(/<\|tool_call>[\s\S]*?(?:<tool_call\|>|$)/gi, "")
      .replace(/<tool_call>[\s\S]*$/i, "")
      // NOTE: weak models sometimes interleave broken fragments of the
      //       tool-call XML into their prose (orphan </tool_call>, stray
      //       <arg_key>/<arg_value> tags). Those tags never occur in a
      //       real answer, and everything from the first fragment onward
      //       is argument soup. Drop it.
      .replace(/<\/?(?:tool_call|arg_key|arg_value)[^>]*>[\s\S]*$/i, "")
      .trim()
  )
}

/**
 * Strip U+FFFD replacement chars and ASCII control bytes before echoing
 * text back in conversation history.
 *
 * WHY: some models occasionally emit invalid UTF-8 that becomes U+FFFD
 *      after decoding. If you send those bytes back through the next
 *      turn's chat template you'll crash Jinja-based templates with a
 *      400 "Failed to parse input". Sanitising keeps your history
 *      round-trippable across models.
 */
function sanitizeForHistory(text: string): string {
  // drop control chars except tab (\x09), newline (\x0A), carriage return (\x0D)
  // eslint-disable-next-line no-control-regex
  const controlChars = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g
  return text
    .replace(/\uFFFD/g, "")
    .replace(controlChars, "")
    .trim()
}

// ─── Turn input + history handling ─────────────────────
// The turn input schema, the sliding-window helper, and the replay
// sanitiser. These are read-and-prep helpers; the orchestration itself
// lives in `runAgentTurn` below.

// WHY: real Zod parsing fails fast on malformed input (wrong types,
//      missing fields, absurd lengths) before any inference time is spent.
//
// NOTE: `history` is the accumulated conversation from prior turns: what
//       the last turn returned in `messages`. The chat session keeps it on
//       the server and passes it back here. You rebuild the system prompt
//       on every call (so it reflects today's date) and prepend it.
export const historyMessageSchema = z.looseObject({
  role: z.string(),
  content: z.union([z.string(), z.null()]).optional(),
  tool_calls: z.array(z.unknown()).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
})

const runQueryInput = z.object({
  question: z.string().min(1).max(4000),
  model: z.string().min(1),
  contextLength: z.number().int().positive().optional(),
  toolUseTrained: z.boolean().optional(),
  history: z.array(historyMessageSchema).default([]),
  // Which SerpApi output the model receives as tool results. See `ToolOutput`.
  toolOutput: z.enum(TOOL_OUTPUTS).default("markdown"),
  // Id the caller reads progress back with (see `readQueryProgress`).
  progressId: z.string().min(1).max(100).optional(),
})

// ─── Query progress ────────────────────────────────────
// A turn records its current stage in this map (on `globalThis`, see
// `lifecycle`), keyed by the caller's `progressId`, so the chat page can
// show real progress while the turn runs in the background. Entries are
// deleted when the turn settles, so the map holds at most one entry per
// turn in flight.

const queryProgress = lifecycle.queryProgress

function setProgress(
  id: string | undefined,
  stage: QueryProgress["stage"],
  detail: string | null = null
): void {
  if (!id) return
  queryProgress.set(id, { stage, detail })
}

/** The current stage of the turn started with `progressId`, if it is still running. */
export const readQueryProgress = createServerOnlyFn(
  (progressId: string): QueryProgress | null =>
    queryProgress.get(progressId) ?? null
)

// WHY: sliding window: keep the system prompt + tools intact and drop
//      the oldest turns when the conversation won't fit in
//      `contextBudget × ratio`. The 30% headroom covers two things: the
//      answer the model hasn't generated yet, and tokenizer drift,
//      cl100k estimates measured 1.03-1.28× LOW against LM Studio's real
//      prompt counts across qwen/gemma/glm runs, so a 0.8 ratio could
//      overflow a full window (0.8 × 1.28 ≈ 1.02) while 0.7 stays safe.
const HISTORY_FIT_RATIO = 0.7

/**
 * Strip prior tool cycles from history before resending it to the model.
 * Tool-call and tool-result messages are dropped; the answer the model wrote
 * from them stays, behind a note that it may be out of date.
 *
 * WHY: small models (≤10B) will happily replay a previous turn's table when
 *      you ask the same question twice, serving stale flight prices as
 *      fresh. Dropping the raw results and labelling the answer, together
 *      with the system prompt's "search again for anything that changes"
 *      rule, keeps that in check.
 *
 *      The answer itself must stay. Replacing it with a placeholder (the
 *      earlier version) broke real follow-ups on 2026-10-02: "which of those
 *      has the best rating?" re-searched and named hotels that were not in
 *      the list, a closing summary re-ran three searches and contradicted
 *      the earlier answers, and Muse Glimmer repeated the placeholder text
 *      back as its answer.
 */
export function sanitizeHistoryForReplay(
  history: Array<ChatCompletionMessageParam>
): Array<ChatCompletionMessageParam> {
  const out: Array<ChatCompletionMessageParam> = []
  const REPLAY_NOTE =
    "[Earlier answer, written from a live search. Use it for what the user refers to. Prices, scores, news, weather and opening hours in it may be out of date: search again for those.]"
  for (let i = 0; i < history.length; i++) {
    const m = history[i]
    if (m.role === "tool") continue
    if (
      m.role === "assistant" &&
      "tool_calls" in m &&
      Array.isArray(m.tool_calls) &&
      m.tool_calls.length > 0
    ) {
      continue
    }
    if (m.role === "assistant" && history[i - 1]?.role === "tool") {
      const answer = typeof m.content === "string" ? m.content : ""
      out.push({
        role: "assistant",
        content: answer ? `${REPLAY_NOTE}\n\n${answer}` : REPLAY_NOTE,
      })
      continue
    }
    out.push(m)
  }
  return out
}

/**
 * Drop oldest turns until `staticOverhead + history` fits within the
 * budget. Returns the trimmed array and how many turns (questions) it
 * dropped.
 *
 * WHY: always trim from the front. The newest turns carry the context
 *      the user actually cares about; the older ones are the safe ones
 *      to lose.
 *
 * `measure` is a parameter, not the module's `countTokens`, on purpose:
 * this is a plain exported function, so anything it references stays in
 * the client build. Passing the tokenizer in keeps `tokens.server.ts`
 * behind the server-function boundary, and lets the tests use a cheap
 * length-based ruler.
 */
export function trimHistoryToFit(
  history: Array<ChatCompletionMessageParam>,
  staticOverhead: number,
  contextBudget: number,
  measure: (value: unknown) => number
): { trimmed: Array<ChatCompletionMessageParam>; dropped: number } {
  if (history.length === 0) {
    return { trimmed: history, dropped: 0 }
  }
  const limit = Math.floor(contextBudget * HISTORY_FIT_RATIO)
  const current = [...history]
  let dropped = 0
  const dropOldest = () => {
    if (current.shift()?.role === "user") dropped++
  }
  while (current.length > 0 && staticOverhead + measure(current) > limit) {
    dropOldest()
  }
  // WHY: a history that starts with an answer whose question was dropped
  //      breaks chat templates that require user and assistant turns to
  //      alternate, and LM Studio then fails every later turn with a 400.
  while (current.length > 0 && current[0].role !== "user") dropOldest()
  return { trimmed: current, dropped }
}

/**
 * Re-run a tool call WITHOUT its restrictor and return the full,
 * untrimmed SerpApi response with its token count and fetch time. Backs
 * the restrictor card's before/after, which shows how much the restrictor
 * saved, in tokens and in latency.
 *
 * Each call is one more SerpApi search: the cache only serves a search
 * whose parameters all match, and this one drops `json_restrictor`. The
 * chat session runs it once per turn and counts it with the turn's own
 * searches (`chat-session.server.ts`).
 */
export const fetchFullResponse = createServerOnlyFn(
  async (
    call: Pick<ToolCallInfo, "name" | "args" | "output">
  ): Promise<FullResponseResult> => {
    const { name, args, output } = call
    if (!isRestrictorTool(name)) {
      throw new ToolArgError(
        `Unknown tool: ${name}`,
        "The compare view was asked for a tool the server doesn't know about."
      )
    }
    const validated = validateToolArgs(name, args)
    const start = performance.now()
    const { payload } = await executeTool(name, validated, output, false)
    return {
      response: payload,
      tokens: countTokens(payload),
      serpApiMs: Math.round(performance.now() - start),
    }
  }
)

// Tool rounds one turn may run. Most /bench answers search once; 3 leaves
// room for a follow-up search or two without letting a model loop.
const MAX_TOOL_ROUNDS = 3

// WHY: sent with the call that follows the last round, which goes without
//      tools. (With `tool_choice: "none"` LM Studio leaves them out of the
//      prompt too, measured on Gemma 4 12B and Qwen 3.8 27B, 2026-10-09.)
//      With no word about it, Qwen 3.8 and Bonsai 27B wrote yet another
//      search as text, and the turn ended with no answer.
const FINAL_ROUND_NOTE = `You have used all ${MAX_TOOL_ROUNDS} search rounds, so you can't search again. Answer now from the search results above. If they don't contain the answer, say what you could not find.`

// Stands in for the answer in the history of a turn that ended without one.
const NO_ANSWER_REPLY = "I couldn't find the answer in my searches."

/**
 * What the next question carries from this turn: everything but the system
 * prompt, or, when the turn ended without an answer, its question and
 * `NO_ANSWER_REPLY`. `historyLength` counts the history messages before the
 * question. Exported for tests.
 */
export function historyAfterTurn(
  messages: Array<ChatCompletionMessageParam>,
  historyLength: number,
  answered: boolean
): Array<ChatCompletionMessageParam> {
  if (answered) return messages.slice(1)
  return [
    ...messages.slice(1, historyLength + 2),
    { role: "assistant", content: NO_ANSWER_REPLY },
  ]
}

// Closes the question in the one retry after an answer call that wrote no
// answer, below the turn's search results.
const ANSWER_NUDGE =
  "You can't search again. Answer the question above from these search results. If they don't contain the answer, say what you could not find."

/**
 * The messages for the one retry after an answer call that wrote no
 * answer: the turn's searches move into the question as plain text, and
 * its tool-call messages go. Exported for tests.
 *
 * WHY: with no tools in the prompt and the final-round note, Qwen 3.8 27B
 *      and Bonsai 27B still wrote another search in their tool-call
 *      syntax, on the answer call and on a retry that only added a nudge
 *      (2026-10-12). The chat template renders the turn's earlier calls in
 *      that syntax, and the model carries on the pattern. With the results
 *      as text there is no call left to carry on.
 */
export function answerFromResultsMessages(
  messages: Array<ChatCompletionMessageParam>,
  calls: Array<ToolCallInfo>
): Array<ChatCompletionMessageParam> {
  let at = messages.length - 1
  while (at >= 0 && messages[at].role !== "user") at--
  const question = at >= 0 ? messages[at].content : null
  const results = calls.map((c) => {
    const body =
      typeof c.response === "string" ? c.response : JSON.stringify(c.response)
    return `### ${toolCallLabel(c)}\n\n${body}`
  })
  return [
    ...messages.slice(0, Math.max(at, 0)),
    {
      role: "user",
      content: [
        typeof question === "string" ? question : "",
        "Your searches returned:",
        ...results,
        ANSWER_NUDGE,
      ].join("\n\n"),
    },
  ]
}

/**
 * The request for an answer call after a search round. With `"none"`, the
 * call after the last round, it sends no tools and adds the final-round
 * note. Exported for tests.
 *
 * WHY: no tools at all, as in the last round of LM Studio's `.act()`. The
 *      prompt is the same as with `tool_choice: "none"`, which LM Studio
 *      sends without them, and a tool call the model writes anyway comes
 *      back as text, which the retry handles.
 */
export function followUpParams(
  model: string,
  messages: Array<ChatCompletionMessageParam>,
  toolChoice: "auto" | "none"
): ChatCompletionCreateParamsNonStreaming {
  // Most of these calls write the answer, so a little more temperature
  // than the tool-picking first call.
  const common = { model, temperature: 0.3, max_tokens: MAX_COMPLETION_TOKENS }
  return toolChoice === "none"
    ? {
        ...common,
        messages: [...messages, { role: "system", content: FINAL_ROUND_NOTE }],
      }
    : { ...common, messages, tools: TOOLS, tool_choice: "auto" }
}

/**
 * What the chat shows when a turn ends without an answer, from the model's
 * last raw reply. Exported for tests.
 *
 * WHY: the usual cause is a model that still wanted to search, writing the
 *      call as text where no search could run. Saying so, with the search
 *      it asked for, tells the user more than "empty response" did.
 */
export function missingAnswerNotice(
  lastRaw: string,
  rounds: number,
  cutOff: boolean
): string {
  const wanted = parseInlineToolCalls(lastRaw).at(0)
  if (wanted) {
    const query =
      typeof wanted.args.query === "string" ? ` ("${wanted.args.query}")` : ""
    const limit =
      rounds >= MAX_TOOL_ROUNDS
        ? `used all ${MAX_TOOL_ROUNDS} search rounds and `
        : ""
    return `The model ${limit}asked for another search${query} instead of answering, so the results so far didn't have what it needed. Try a more specific question, or another model.`
  }
  if (cutOff) {
    return `The model used its whole ${MAX_COMPLETION_TOKENS.toLocaleString("en-US")}-token reply budget without writing an answer. Try again, or pick another model.`
  }
  return "The model returned an empty response after the tool call. Try rephrasing, or pick a different model."
}

/**
 * The agent loop after the first tool round: ask the model again with the
 * tools still available, run the searches it asks for, and repeat until it
 * answers. After `maxToolRounds` rounds the next call gets `"none"`, and
 * `runAgentTurn` sends it without tools, the same rule as the last round of
 * LM Studio's `.act()`.
 *
 * A later round that fails (unreadable arguments, a SerpApi error) ends the
 * loop and keeps the results so far: one bad follow-up must not sink a turn
 * that already has data. Returns the rounds run, counting the first, and
 * the last completion. Exported for tests; `runAgentTurn` supplies the
 * LM Studio and SerpApi calls.
 */
export async function runToolLoop<TCompletion, TCall>(opts: {
  maxToolRounds: number
  complete: (toolChoice: "auto" | "none") => Promise<TCompletion>
  // The tool calls in a completion, structured or written as text.
  readCalls: (completion: TCompletion) => Array<TCall>
  // Runs the calls and appends them to the conversation. Throws on failure.
  runRound: (calls: Array<TCall>) => Promise<void>
  onRoundFailed?: (err: unknown) => void
}): Promise<{ rounds: number; last: TCompletion }> {
  let rounds = 1
  for (;;) {
    const canSearch = rounds < opts.maxToolRounds
    const completion = await opts.complete(canSearch ? "auto" : "none")
    if (!canSearch) return { rounds, last: completion }
    try {
      const calls = opts.readCalls(completion)
      if (calls.length === 0) return { rounds, last: completion }
      await opts.runRound(calls)
    } catch (err) {
      opts.onRoundFailed?.(err)
      return { rounds, last: completion }
    }
    rounds += 1
  }
}

/**
 * Run one user query end-to-end on the server.
 *
 * The flow you'll see below: trim history to fit context → first
 * inference (model picks tools) → execute SerpApi calls in parallel (each
 * pre-trimmed by its restrictor) → ask again with the tools still on, and
 * search again while the model asks, up to `MAX_TOOL_ROUNDS` → the final
 * answer. Returns the answer plus a token breakdown, per-phase latencies,
 * and tool-call metadata for the UI.
 *
 * Your SerpApi key never leaves this module. The function only runs
 * inside TanStack Start's server boundary.
 */
export type RunQueryInput = z.infer<typeof runQueryInput>

/**
 * One full agent turn: search until the model answers. Called on the
 * server by the chat session (`chat-session.server.ts`) and the benchmark
 * job (`bench-job.server.ts`), never straight from the browser.
 *
 * WHY: `createServerOnlyFn`, not a plain export. Plain exports stay in the
 *      client bundle with everything they reference, which would pull the
 *      tokenizer into the browser. Wrapped, the client build drops the body.
 */
export const runAgentTurn = createServerOnlyFn(
  async (data: RunQueryInput): Promise<RunQueryResult> => {
    const start = performance.now()
    const {
      question,
      model,
      contextLength,
      toolUseTrained,
      history,
      toolOutput,
    } = data
    const progressId = data.progressId

    // `effectiveContext` drives history trimming (falls back to the
    // requested size if we can't confirm a load). `loadedContext` is the
    // size LM Studio actually accepted (only set on a real load) and is
    // what the UI shows as the true window. They differ when a load is
    // backed off, or when LM Studio can't be reached at all.
    let effectiveContext = contextLength
    let loadedContext: number | null = null
    let appliedContext: number | null = null

    const emptyBreakdown = (): Breakdown => ({
      tool_definitions: 0,
      system_prompt: 0,
      conversation_history: 0,
      user_message: 0,
      tool_call: 0,
      tool_result: 0,
      final_response: 0,
    })
    const emptyPhases = (): Phases => ({
      firstInferenceMs: 0,
      toolExecutionMs: 0,
      secondInferenceMs: 0,
    })

    // WHY: fast path for non-tool-trained models. The structured
    //      `tool_calls` field will come back empty and the inline
    //      parser will fail silently. Better to tell the user up
    //      front than to let them watch a blank loop.
    if (toolUseTrained === false) {
      return {
        ok: false,
        answer:
          "This model isn't trained for tool use, so it can't call SerpApi. Pick a tool-trained model, such as Qwen 3.8 or Gemma 4, in the model picker.",
        breakdown: emptyBreakdown(),
        exactUsage: null,
        totalUsage: null,
        toolCalls: [],
        sources: [],
        elapsedMs: Math.round(performance.now() - start),
        phases: emptyPhases(),
        messages: history as Array<ChatCompletionMessageParam>,
        trimmedTurns: 0,
        conversationTokens: 0,
        loadedContext: null,
        appliedContext: null,
        retried: false,
        cutOff: false,
        answerMissing: false,
        toolRounds: 0,
        rawReply: null,
      }
    }

    // This query keeps the model resident: the idle-unload countdown is
    // cancelled here and re-armed in `finally` once the last in-flight
    // query settles (see `beginQuery` / `endQuery`). Outside the `try` so
    // the pair is always balanced.
    beginQuery(model)
    // Outside the `try` so a turn that fails after its searches still
    // reports them: the benchmark inspector shows what ran and how big it was.
    const toolCalls: Array<ToolCallInfo> = []
    try {
      setProgress(progressId, "load")
      // WHY: loading this model unloads every other one. Without this check
      //      a chat question on another model unloads the model a running
      //      benchmark cell (or an earlier question) is still using.
      const busy = modelInUseOtherThan(model)
      if (busy) {
        throw new LmStudioError(
          `Another question is still running on ${busy}.`,
          "Wait for it to finish, or stop the benchmark run, then ask again."
        )
      }
      // NOTE: the load probe may shrink the context to fit this machine, and
      //       MLX may apply more or less than asked. Budget against the
      //       smaller of the two, so history trimming never overflows the
      //       real window and never grows past what was asked for.
      if (typeof contextLength === "number") {
        const load = await ensureModelLoaded(model, contextLength)
        appliedContext = load.applied
        loadedContext =
          load.applied === null
            ? load.requested
            : Math.min(load.requested, load.applied)
        effectiveContext = loadedContext
      }

      const client = new OpenAI({
        baseURL: lmStudioUrl(),
        // LM Studio ignores the key unless "Require Authentication" is on.
        apiKey: lmStudioApiKey() ?? "lm-studio",
        // WHY: the SDK retries a timed-out request twice by default, silently.
        //      A benchmark then records the retry's answer and timing as if
        //      the first call had produced them. A timeout must surface.
        maxRetries: 0,
        timeout:
          toolOutput === "markdown-full"
            ? LM_STUDIO_CHAT_TIMEOUT_FULL_MS
            : LM_STUDIO_CHAT_TIMEOUT_MS,
      })
      const systemPrompt = buildSystemPrompt()

      // WHY: LM Studio rejects a reply it can't parse into the model's
      //      tool-call format ("does not match the expected peg-native
      //      format"). It's a sampling slip: Muse Glimmer lost three answers
      //      this way in one chat on 2026-10-09, and the same question went
      //      through when asked again. One more try costs less than a
      //      failed turn.
      const createCompletion = async (
        params: ChatCompletionCreateParamsNonStreaming
      ): Promise<ChatCompletion> => {
        try {
          return await client.chat.completions.create(params)
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err)
          if (!isUnparseableReply(m)) throw err
          devWarn(
            "[runQuery] LM Studio could not parse the reply, asking again:",
            m
          )
          return await client.chat.completions.create(params)
        }
      }

      // WHY: static overhead = system prompt + tool definitions + the
      //      current user message + a rough budget for the answer you
      //      haven't generated yet. Budget falls back to a conservative
      //      8192 when `contextLength` isn't provided (first call).
      const castedHistory = history as Array<ChatCompletionMessageParam>
      // WHY: neutralise replayable tool payloads BEFORE trimming so the
      //      token counts reflect what the model actually sees. Skip
      //      this and a small model will echo the previous turn's
      //      pre-rendered table instead of re-calling the tool.
      const sanitizedHistory = sanitizeHistoryForReplay(castedHistory)
      const toolsTokens = countTokens(TOOLS)
      const systemTokens = countTokens(systemPrompt)
      const questionTokens = countTokens(question)
      const ANSWER_HEADROOM = 1024 // reserved for tool result + answer
      const staticOverhead =
        toolsTokens + systemTokens + questionTokens + ANSWER_HEADROOM
      const budget = effectiveContext ?? 8192
      const { trimmed: trimmedHistory, dropped: trimmedTurns } =
        trimHistoryToFit(sanitizedHistory, staticOverhead, budget, countTokens)

      const messages: Array<ChatCompletionMessageParam> = [
        { role: "system", content: systemPrompt },
        ...trimmedHistory,
        { role: "user", content: question },
      ]

      const breakdown: Breakdown = {
        tool_definitions: toolsTokens,
        system_prompt: systemTokens,
        // An empty history would count as "[]", one token.
        conversation_history:
          trimmedHistory.length > 0 ? countTokens(trimmedHistory) : 0,
        user_message: questionTokens,
        tool_call: 0,
        tool_result: 0,
        final_response: 0,
      }

      const phases: Phases = emptyPhases()

      // WHY: low temperature on the tool-picking call. Small models
      //      pick tools more reliably when you sample close to
      //      deterministic. Keep the creativity for the answer call.
      setProgress(progressId, "think")
      const t0 = performance.now()
      let first: ChatCompletion
      try {
        first = await createCompletion({
          model,
          messages,
          tools: TOOLS,
          tool_choice: "auto",
          temperature: 0.1,
          max_tokens: MAX_COMPLETION_TOKENS,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new LmStudioError(
          `LM Studio chat completion failed: ${msg}`,
          answerCallHint(
            msg,
            "Check that LM Studio is running on :1234 and the selected model is loaded."
          )
        )
      }
      phases.firstInferenceMs = Math.round(performance.now() - t0)
      // Throws when an MLX model read more than the app loaded.
      const ensureFits = (usage: typeof first.usage) => {
        const over = promptOverBudget(usage?.prompt_tokens, loadedContext)
        if (over) {
          throw new LmStudioError(
            over,
            "MLX models run longer prompts anyway; the app stops them so every model gets the same window. Use a restricted output, or set LMSTUDIO_CONTEXT_LENGTH higher."
          )
        }
      }
      ensureFits(first.usage)
      let cutOff = first.choices[0].finish_reason === "length"
      const msg = first.choices[0].message
      let answer = ""
      let retried = false
      // How many tool rounds ran: 0 for a direct answer, up to
      // `MAX_TOOL_ROUNDS`.
      let rounds = 0
      // The model's last raw reply, kept so a failed turn can show what
      // the model actually wrote instead of a generic error.
      let lastRaw = ""
      // What the turn's last call carried, for its breakdown: the tool
      // definitions unless it couldn't search, plus any note added to it.
      let finalCallSentTools = true
      let finalCallNote = ""
      // One entry per executed call: the SERP link captured from
      // `search_metadata` before it was stripped from the model's view.
      const toolSearchUrls: Array<string | null> = []
      // NOTE: usage from the final call is ground truth: LM Studio's
      //       own tokenizer, not the cl100k estimate. `usages` collects
      //       every completion so the turn total can be summed as well.
      let finalUsage = first.usage
      const usages: Array<typeof first.usage> = [first.usage]

      // WHY: collect every tool call the model emitted this turn. You
      //      accept two shapes: the structured `tool_calls` field
      //      (OpenAI-compat) and inline `<tool_call>` XML used by some
      //      open models. Zero calls means the model answered directly.
      type ResolvedCall = {
        name: string
        rawArgs: string
        args: Record<string, unknown>
        id: string
        isInline: boolean
      }
      const readCalls = (reply: typeof msg): Array<ResolvedCall> => {
        const calls: Array<ResolvedCall> = []
        if (reply.tool_calls && reply.tool_calls.length > 0) {
          for (const call of reply.tool_calls) {
            if (call.type !== "function") {
              throw new LmStudioError(
                `Unexpected tool call type: ${call.type}`,
                "The model returned a non-function tool call. This shouldn't happen with OpenAI-compat APIs."
              )
            }
            let args: Record<string, unknown>
            try {
              args = JSON.parse(call.function.arguments) as Record<
                string,
                unknown
              >
            } catch {
              throw new ToolArgError(
                `Model emitted non-JSON tool args: ${call.function.arguments}`,
                "Small models sometimes break structured output. Retry, or try a different model."
              )
            }
            calls.push({
              name: call.function.name,
              rawArgs: call.function.arguments,
              args,
              id: call.id,
              isInline: false,
            })
          }
        } else if (reply.content) {
          const inlineCalls = parseInlineToolCalls(reply.content)
          for (const [i, c] of inlineCalls.entries()) {
            calls.push({
              name: c.name,
              rawArgs: c.rawArgs,
              args: c.args,
              id: `inline-${Date.now()}-${i}`,
              isInline: true,
            })
          }
        }
        return calls
      }
      const resolvedCalls = readCalls(msg)

      if (resolvedCalls.length > 0) {
        // WHY: validate + execute every call in parallel. This is the
        //      same pattern OpenAI and Anthropic recommend. The model
        //      asks for N things, you run them concurrently, then send
        //      back N results in one shot.
        setProgress(
          progressId,
          "tools",
          resolvedCalls.map((c) => c.name).join(" + ")
        )
        // Execute one round of tool calls and append the assistant turn and
        // the tool results to `messages`. Runs once per round of the loop.
        let roundNo = 0
        const runToolRound = async (calls: Array<ResolvedCall>) => {
          roundNo += 1
          const round = roundNo
          // NOTE: the phase timer wraps the whole batch. Parallel calls
          //       overlap, so summing per-call durations would report more
          //       time than actually passed. Each call's own duration still
          //       ships as `serpApiMs`.
          const toolPhaseStart = performance.now()
          const executed = await Promise.all(
            calls.map(async (call) => {
              const validated = validateToolArgs(call.name, call.args)
              // `validateToolArgs` already rejected unknown tools, so the
              // guard here is for the type narrowing, not a second check.
              if (!isRestrictorTool(call.name)) {
                throw new ToolArgError(
                  `Unknown tool: ${call.name}`,
                  "The model picked a tool the server doesn't know about."
                )
              }
              // `restrictor` records which restrictor string actually
              // produced `response`. It changes if the Finance fallback
              // below pivots the call to google_search.
              let restrictor = restrictorFor(call.name, toolOutput)
              // SerpApi searches this call spends: 2 with the fallback below.
              let searches = 1
              const execStart = performance.now()
              let { payload: response, searchUrl } = await executeTool(
                call.name,
                validated,
                toolOutput
              )
              let execMs = performance.now() - execStart

              // WHY: graceful degradation for Finance. When SerpApi has
              //      no quote for a symbol the restricted response is
              //      missing `summary.title`/`summary.price` and ships
              //      an empty stats list. Pivoting to google_search with
              //      the same query gives the model real data to answer
              //      from instead of a blank object.
              if (
                call.name === "google_finance_search" &&
                isEmptyFinanceResponse(response)
              ) {
                const query = String(validated.query ?? "")
                if (query) {
                  const fbStart = performance.now()
                  const fallback = await executeTool(
                    "google_search",
                    { query },
                    toolOutput
                  )
                  execMs += performance.now() - fbStart
                  searches = 2
                  restrictor = restrictorFor("google_search", toolOutput)
                  searchUrl = fallback.searchUrl
                  const note = `Google Finance had no direct quote for "${query}". These are web search results instead.`
                  response =
                    typeof fallback.payload === "string"
                      ? `> ${note}\n\n${fallback.payload}`
                      : {
                          ...(fallback.payload as Record<string, JsonValue>),
                          fallback_from: "google_finance_search",
                          note,
                        }
                }
              }

              return {
                call,
                validated,
                response,
                restrictor,
                execMs,
                searchUrl,
                searches,
              }
            })
          )
          phases.toolExecutionMs += Math.round(
            performance.now() - toolPhaseStart
          )

          for (const r of executed) {
            const responseTokens = countTokens(r.response)
            toolCalls.push({
              name: r.call.name,
              args: r.validated,
              restrictor: r.restrictor,
              output: toolOutput,
              response: r.response,
              tokens: responseTokens,
              serpApiMs: Math.round(r.execMs),
              round,
              searches: r.searches,
            })
            toolSearchUrls.push(r.searchUrl)
            breakdown.tool_call += countTokens(r.call.rawArgs)
            breakdown.tool_result += responseTokens
          }

          // WHY: rebuild the assistant turn so the second completion
          //      sees a clean structured `tool_calls` array, no matter
          //      whether the model originally used the native field or
          //      inline XML. This way the rest of your code only handles
          //      one shape.
          messages.push({
            role: "assistant",
            content: null,
            tool_calls: calls.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.name, arguments: c.rawArgs },
            })),
          })
          for (const [i, r] of executed.entries()) {
            messages.push({
              role: "tool",
              tool_call_id: calls[i].id,
              // Markdown goes to the model as-is; JSON is serialised.
              content:
                typeof r.response === "string"
                  ? r.response
                  : JSON.stringify(r.response),
            })
          }
        }

        await runToolRound(resolvedCalls)

        // WHY: the tools stay on every call but the last (see
        //      `followUpParams`), so LM Studio parses a second search into
        //      `tool_calls` instead of leaving it in the text.
        // Which call wrote the loop's last reply. Set inside `complete`,
        // which TypeScript can't follow: no narrowing.
        let lastCall = "auto" as "auto" | "none" | "fallback"
        const loop = await runToolLoop({
          maxToolRounds: MAX_TOOL_ROUNDS,
          complete: async (toolChoice) => {
            setProgress(progressId, "answer")
            lastCall = toolChoice
            const t = performance.now()
            let reply: typeof first
            try {
              reply = await createCompletion(
                followUpParams(model, messages, toolChoice)
              )
            } catch (err) {
              const m = err instanceof Error ? err.message : String(err)
              if (!isUnparseableReply(m)) {
                throw new LmStudioError(
                  `LM Studio answer call failed: ${m}`,
                  answerCallHint(m)
                )
              }
              // WHY: LM Studio could not parse the reply, twice (see
              //      `createCompletion`). The turn already has search
              //      results, so ask for the answer from them as plain
              //      text, with no tools and no tool call to parse.
              devWarn(
                "[runQuery] LM Studio could not parse the reply again, asking for the answer from the results:",
                m
              )
              lastCall = "fallback"
              retried = true
              try {
                reply = await createCompletion({
                  model,
                  messages: answerFromResultsMessages(messages, toolCalls),
                  temperature: 0.3,
                  max_tokens: MAX_COMPLETION_TOKENS,
                })
              } catch (fallbackErr) {
                const fm =
                  fallbackErr instanceof Error
                    ? fallbackErr.message
                    : String(fallbackErr)
                throw new LmStudioError(
                  `LM Studio answer call failed: ${fm}`,
                  answerCallHint(fm)
                )
              }
            }
            phases.secondInferenceMs += Math.round(performance.now() - t)
            ensureFits(reply.usage)
            usages.push(reply.usage)
            return reply
          },
          readCalls: (reply) => readCalls(reply.choices[0].message),
          runRound: async (calls) => {
            setProgress(
              progressId,
              "tools",
              calls.map((c) => c.name).join(" + ")
            )
            await runToolRound(calls)
          },
          onRoundFailed: (err) =>
            devWarn(
              "[runQuery] a follow-up search failed, asking for the answer instead:",
              err instanceof Error ? err.message : String(err)
            ),
        })
        rounds = loop.rounds
        if (lastCall !== "auto") {
          finalCallSentTools = false
          finalCallNote = lastCall === "none" ? FINAL_ROUND_NOTE : ANSWER_NUDGE
        }
        lastRaw = loop.last.choices[0].message.content ?? ""
        cutOff = loop.last.choices[0].finish_reason === "length"
        answer = stripInlineToolCalls(lastRaw)
        finalUsage = loop.last.usage

        // WHY: an empty answer (or one that still ends in a tool call)
        //      gets one retry, with the searches as plain text (see
        //      `answerFromResultsMessages`). It goes through a throwaway
        //      `retryMessages` so it never pollutes the history you return
        //      to the client.
        if (
          lastCall !== "fallback" &&
          (answer.length === 0 || hasInlineToolCall(lastRaw))
        ) {
          devWarn(
            "[runQuery] answer call wrote no answer, retrying. Raw content:",
            JSON.stringify(lastRaw)
          )
          retried = true
          finalCallSentTools = false
          finalCallNote = ANSWER_NUDGE
          const retryMessages = answerFromResultsMessages(messages, toolCalls)
          const retryStart = performance.now()
          const retry = await createCompletion({
            model,
            messages: retryMessages,
            temperature: 0.3,
            max_tokens: MAX_COMPLETION_TOKENS,
          })
          phases.secondInferenceMs += Math.round(performance.now() - retryStart)
          ensureFits(retry.usage)
          cutOff = retry.choices[0].finish_reason === "length"
          const retryRaw = retry.choices[0].message.content ?? ""
          answer = stripInlineToolCalls(retryRaw)
          finalUsage = retry.usage
          usages.push(retry.usage)
          lastRaw = retryRaw
          if (answer.length === 0 || hasInlineToolCall(retryRaw)) {
            devWarn(
              "[runQuery] retry wrote no answer either. Raw content:",
              JSON.stringify(retryRaw)
            )
            answer = ""
          }
        }
      } else {
        // No tool call: direct answer. Strip any stray XML in case the
        // model emitted an unparseable fragment.
        answer = stripInlineToolCalls(msg.content ?? "")
      }

      // WHY: last-resort fallback. If the retry above also came back
      //      empty, tell the user explicitly instead of rendering a
      //      blank message.
      const answerMissing = answer.length === 0
      if (answerMissing) {
        answer = missingAnswerNotice(lastRaw, rounds, cutOff)
      }

      // WHY: push the final assistant answer onto the conversation so
      //      it appears in history on the next turn. Otherwise the
      //      model will forget what it just told the user. Sanitise
      //      first: the occasional invalid UTF-8 byte will crash the
      //      receiving chat template on the next request.
      if (!answerMissing) {
        messages.push({
          role: "assistant",
          content: sanitizeForHistory(answer),
        })
      }

      // The breakdown describes the turn's last call: no tool definitions
      // when it couldn't search, and the note it carried, if any.
      if (!finalCallSentTools) breakdown.tool_definitions = 0
      if (finalCallNote) breakdown.system_prompt += countTokens(finalCallNote)
      breakdown.final_response = countTokens(answer)
      // WHY: one source entry per tool call that returned a SerpApi
      //      URL, labelled so you can tell parallel calls apart in the
      //      Sources panel (e.g. "Finance · AAPL" vs "Finance · TSLA").
      const toolSources: Array<{ url: string; label: string }> = []
      for (let i = 0; i < toolSearchUrls.length; i++) {
        const url = toolSearchUrls[i]
        if (url) {
          toolSources.push({
            url,
            label: `SerpApi · ${toolCallLabel(toolCalls[i])}`,
          })
        }
      }
      const sources = extractSources(answer, toolSources)
      const elapsedMs = Math.round(performance.now() - start)
      const exactUsage: ExactUsage | null = finalUsage
        ? toExactUsage(finalUsage)
        : null
      const totalUsage = sumUsage(usages)

      await appendBenchmarkLog({
        timestamp: new Date().toISOString(),
        query: redactSecrets(question),
        model,
        // NOTE: kept as single-value for backward compatibility with
        //       any older analysis scripts you have lying around;
        //       `tools_called` carries the full array.
        tool_called: toolCalls[0]?.name ?? null,
        tools_called: toolCalls.map((c) => c.name),
        tokens: {
          tool_definitions: breakdown.tool_definitions,
          system_prompt: breakdown.system_prompt,
          user_message: breakdown.user_message,
          tool_call: breakdown.tool_call,
          tool_result: breakdown.tool_result,
          final_response: breakdown.final_response,
          total: contextTotal(breakdown),
        },
        exact_usage: exactUsage,
        sources_count: sources.length,
        time_seconds: Number((elapsedMs / 1000).toFixed(2)),
        phases,
        success: !answerMissing,
        response: answer,
      })

      // NOTE: "conversation so far": what the next call will carry
      //       before you append the next user message. Mirrors LM
      //       Studio's own conversation-tokens counter.
      // WHY: a turn with no answer keeps its question, with a short reply
      //      in place of the answer. Kept whole, the notice read as the
      //      model's own answer. Dropped, a follow-up lost its subject:
      //      after two such turns, Bonsai 27B asked which product "Can you
      //      check their prices please" meant (2026-10-12).
      const nextHistory = historyAfterTurn(
        messages,
        trimmedHistory.length,
        !answerMissing
      )
      const conversationTokens =
        toolsTokens +
        systemTokens +
        countTokens(sanitizeHistoryForReplay(nextHistory))

      return {
        ok: true,
        answer,
        breakdown,
        exactUsage,
        totalUsage,
        toolCalls,
        sources,
        elapsedMs,
        phases,
        // NOTE: ship everything except the system prompt (index 0)
        //       back to the client. It'll send it as `history` on
        //       the next call.
        messages: nextHistory,
        trimmedTurns,
        conversationTokens,
        loadedContext,
        appliedContext,
        retried,
        cutOff,
        answerMissing,
        toolRounds: rounds,
        rawReply: answerMissing ? lastRaw || null : null,
      }
    } catch (err) {
      const elapsedMs = Math.round(performance.now() - start)
      return {
        ok: false,
        answer: formatAgentError(err),
        breakdown: emptyBreakdown(),
        exactUsage: null,
        totalUsage: null,
        toolCalls,
        sources: [],
        elapsedMs,
        phases: emptyPhases(),
        // WHY: preserve the existing history on error. You don't
        //      want the user's next attempt to lose all the prior
        //      turns just because one call failed.
        messages: history as Array<ChatCompletionMessageParam>,
        trimmedTurns: 0,
        conversationTokens: 0,
        loadedContext,
        appliedContext,
        retried: false,
        cutOff: false,
        answerMissing: false,
        toolRounds: 0,
        rawReply: null,
      }
    } finally {
      if (progressId) queryProgress.delete(progressId)
      endQuery(model)
    }
  }
)
