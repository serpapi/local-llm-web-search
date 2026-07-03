import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { createServerFn } from "@tanstack/react-start"
import { getEncoding } from "js-tiktoken"
import OpenAI from "openai"
import {
  InvalidArgumentError,
  MissingApiKeyError,
  getJson,
  config as serpApiConfig,
} from "serpapi"
import { z } from "zod"

import { RESTRICTORS, isRestrictorTool } from "./restrictors"

import type { RestrictorTool } from "./restrictors"
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions"

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
const LM_STUDIO_BASE_URL = (
  process.env.LMSTUDIO_URL ?? "http://localhost:1234"
).replace(/\/+$/, "")
const LM_STUDIO_URL = `${LM_STUDIO_BASE_URL}/v1`
const LM_STUDIO_NATIVE_URL = `${LM_STUDIO_BASE_URL}/api/v1`

// ─── Timeouts ──────────────────────────────────────────
// Chat is generous because cold-loading a large model can take 30–40s on
// first inference; the others fail fast. SerpApi's value is enforced by the
// SDK config below, not per-call.
const LM_STUDIO_FETCH_TIMEOUT_MS = 10_000
const LM_STUDIO_CHAT_TIMEOUT_MS = 60_000
// WHY: a cold model load can take 30–40s. The list/unload calls fail fast
//      (10s), but the load itself gets its own generous budget — time it
//      out too early and a slow-but-valid load looks like a guardrail block,
//      so the back-off probe would shrink the context for no reason.
const LM_STUDIO_LOAD_TIMEOUT_MS = 60_000
const SERPAPI_TIMEOUT_MS = 20_000

// Idle auto-unload window. The app loads models EXPLICITLY (see
// `tryLoadModel`) so the back-off probe can size context to the machine, but
// an explicit load PINS the model — LM Studio's "Auto unload unused JIT loaded
// models" TTL only ever evicts JIT-loaded models, and a `ttl` on the chat
// request does NOT evict a pinned one (verified against the live server). So
// the app reproduces the idle-unload itself: after each query it arms a timer
// (see `armIdleUnload`) that unloads the model once it has been idle this long.
// Five minutes is this app's own default; override with LMSTUDIO_TTL_SECONDS.
const LM_STUDIO_IDLE_TTL_SECONDS = (() => {
  const raw = Number(process.env.LMSTUDIO_TTL_SECONDS)
  return Number.isFinite(raw) && raw > 0 ? raw : 300
})()

// WHY: configure the SerpApi SDK once at module load — every `getJson` call
//      inherits these defaults, keeping each executor noise-free.
serpApiConfig.timeout = SERPAPI_TIMEOUT_MS

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
 * show to the user — keep it short and concrete ("restart LM Studio",
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
  constructor(message: string, suggestion: string) {
    super(message, suggestion)
    this.name = "SerpApiError"
  }
}

class ToolArgError extends AgentError {
  constructor(message: string, suggestion: string) {
    super(message, suggestion)
    this.name = "ToolArgError"
  }
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
//      enum-style parameters — splitting on the noun-level eliminates a
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
              "ISO 3166-1 alpha-2 country code (e.g. 'us', 'gb', 'de', 'fr', 'jp', 'mx', 'cl'). Must be a single country — do NOT use regional codes like 'eu', 'apac', 'latam'. If the user mentions a region, pick a representative country.",
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
              "ISO 3166-1 alpha-2 country code (e.g. 'us', 'gb', 'de', 'fr', 'jp', 'mx', 'cl'). Must be a single country — do NOT use regional codes like 'eu', 'apac', 'latam'. If the user mentions a region, pick a representative country.",
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
              "ISO 3166-1 alpha-2 country code (e.g. 'us', 'gb', 'de', 'fr', 'jp', 'mx', 'cl'). Must be a single country — do NOT use regional codes like 'eu', 'apac', 'latam'. If the user mentions a region, pick a representative country.",
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
            description: "IATA code of the departure airport (e.g. 'SCL').",
          },
          arrival_id: {
            type: "string",
            description: "IATA code of the arrival airport (e.g. 'MAD').",
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
              "ISO 3166-1 alpha-2 country code (e.g. 'us', 'gb', 'de', 'fr', 'jp', 'mx', 'cl'). Must be a single country — do NOT use regional codes like 'eu', 'apac', 'latam'. If the user mentions a region, pick a representative country.",
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
              "ISO 3166-1 alpha-2 country code (e.g. 'us', 'gb', 'de', 'fr', 'jp', 'mx', 'cl'). Must be a single country — do NOT use regional codes like 'eu', 'apac', 'latam'. If the user mentions a region, pick a representative country.",
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
//       fields defensively, so `any` is the honest type here — if you
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

const googleSearchArgs = z.object({
  query: z.string().min(1),
  num: z.number().int().positive().max(20).optional(),
  gl: z.string().optional(),
  hl: z.string().optional(),
})
const googleFinanceArgs = z.object({
  query: z.string().min(1),
  hl: z.string().optional(),
  window: z.enum(["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"]).optional(),
})
const googleNewsArgs = z.object({
  query: z.string().min(1),
  gl: z.string().optional(),
  hl: z.string().optional(),
})
const googleMapsArgs = z.object({
  query: z.string().min(1),
  gl: z.string().optional(),
  hl: z.string().optional(),
})
const googleFlightsArgs = z.object({
  departure_id: z.string().min(2),
  arrival_id: z.string().min(2),
  outbound_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  return_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  type: z.enum(["1", "2"]).optional(),
  currency: z.string().optional(),
  hl: z.string().optional(),
  travel_class: z.enum(["1", "2", "3", "4"]).optional(),
})
const googleHotelsArgs = z.object({
  query: z.string().min(1),
  check_in_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  check_out_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  adults: z.number().int().positive().max(20).optional(),
  currency: z.string().optional(),
  gl: z.string().optional(),
  hl: z.string().optional(),
})
const googleShoppingArgs = z.object({
  query: z.string().min(1),
  gl: z.string().optional(),
  hl: z.string().optional(),
})

// NOTE: keyed by `RestrictorTool` so this map, `TOOL_EXECUTORS`, and the
//       `RESTRICTORS` map in `restrictors.ts` are guaranteed to cover the
//       exact same set of tools — add or remove one and the compile fails
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

// WHY: tool args are always JSON primitives — the Zod schemas only accept
//      strings, numbers, booleans, and enums. Pinning the type here makes
//      ToolCallInfo serialisable across TanStack Start's RPC boundary so
//      you don't have to fight `unknown` on the client.
export type ToolArgValue = string | number | boolean | null
export type ToolArgs = Record<string, ToolArgValue>

// WHY: TanStack Start's RPC serialiser rejects `unknown` but accepts any
//      fully structural JSON tree. This recursive type is what you ship
//      SerpApi tool responses through to the client.
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | Array<JsonValue>
  | { [key: string]: JsonValue }

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
      "The model produced malformed arguments. Small models sometimes do this — try rephrasing the question."
    )
  }
  return result.data as ToolArgs
}

// ─── Executors ─────────────────────────────────────────
// One executor per tool. They all funnel through `serpApi()` below, which
// uses the SDK's module-level timeout config and converts SDK-specific
// errors into the typed `SerpApiError` so you only handle one error shape.

/**
 * Thin wrapper around the SerpApi SDK. Lazy-inits the API key on first
 * call (so you can import this module in tests without env vars set), and
 * maps SDK errors to `SerpApiError` with actionable suggestions.
 */
async function serpApi(params: Record<string, unknown>): Promise<SerpApiJson> {
  if (!serpApiConfig.api_key) {
    serpApiConfig.api_key = serpApiKey()
  }
  try {
    return await getJson(params)
  } catch (err) {
    if (err instanceof AgentError) throw err
    if (err instanceof MissingApiKeyError) {
      throw new SerpApiError(
        "SERPAPI_API_KEY is not set.",
        "Add SERPAPI_API_KEY=<your key> to .env and restart `bun dev`."
      )
    }
    if (err instanceof InvalidArgumentError) {
      throw new SerpApiError(
        `SerpApi rejected the arguments: ${err.message}`,
        "The model produced malformed tool arguments. Zod validation should have caught this — if not, try rephrasing the question."
      )
    }
    const msg = err instanceof Error ? err.message : String(err)
    // NOTE: the SerpApi SDK surfaces its native timeout as a fetch-style
    //       abort error — that's why we match on /abort|timed out/.
    if (/abort|timed?\s*out/i.test(msg)) {
      throw new SerpApiError(
        `SerpApi timed out after ${SERPAPI_TIMEOUT_MS / 1000}s.`,
        "Retry the query, or check https://serpapi.com/status."
      )
    }
    throw new SerpApiError(
      `SerpApi request failed: ${msg}`,
      "Check that SERPAPI_API_KEY is valid and you haven't hit your monthly quota."
    )
  }
}

// NOTE: executor arg types are inferred from the Zod schemas above. By
//       the time you reach an executor, `validateToolArgs` has already
//       parsed and narrowed the input — the casts in `TOOL_EXECUTORS`
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
// `toolParams` maps each tool to its SerpApi request parameters — one
// switch, so you can see every tool's call shape in one place.
// `executeTool` runs that call with the matching `json_restrictor`
// (the server-side field selection from https://serpapi.com/json-restrictor),
// so the response arrives pre-trimmed to the fields the model needs and
// no client-side formatting is required. `executeToolUnrestricted` runs
// the identical call WITHOUT the restrictor — it backs the optional
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
      return {
        engine: "google_flights",
        departure_id: a.departure_id,
        arrival_id: a.arrival_id,
        outbound_date: a.outbound_date,
        type: a.type ?? "2",
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

/** Run a tool's SerpApi call with its server-side restrictor applied. */
function executeTool(
  name: RestrictorTool,
  args: ToolArgs
): Promise<SerpApiJson> {
  return serpApi({
    ...toolParams(name, args),
    json_restrictor: RESTRICTORS[name],
  })
}

/**
 * Run a tool's SerpApi call WITHOUT the restrictor — the full, untrimmed
 * response. Only the optional compare view calls this; the chat loop
 * always uses `executeTool`.
 */
function executeToolUnrestricted(
  name: RestrictorTool,
  args: ToolArgs
): Promise<SerpApiJson> {
  return serpApi(toolParams(name, args))
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
  const summary = response?.summary
  if (summary?.title || summary?.price) return false
  const stats = response?.knowledge_graph?.key_stats?.stats
  if (Array.isArray(stats) && stats.length > 0) return false
  const news = response?.news_results
  if (Array.isArray(news) && news.length > 0) return false
  return true
}

// ─── Token counting ────────────────────────────────────
// You're using tiktoken's cl100k_base (the GPT-4 encoding) as a stand-in
// for the real model tokenizer. The exact counts come from LM Studio's
// API when a call actually runs; cl100k is just a consistent ruler for
// comparing segments offline.
const encoding = getEncoding("cl100k_base")

/**
 * Estimate token count for a string or JSON-serialisable value using the
 * GPT-4 encoding. Used for the per-segment breakdown in the UI.
 */
export function countTokens(value: unknown): number {
  const text = typeof value === "string" ? value : JSON.stringify(value)
  return encoding.encode(text).length
}

export type Breakdown = {
  tool_definitions: number
  system_prompt: number
  conversation_history: number
  user_message: number
  tool_call: number
  tool_result: number
  final_response: number
}

export type ToolCallInfo = {
  name: string
  args: ToolArgs
  // The `json_restrictor` string that produced `response` — shown in the
  // tool-call dialog as the literal request that did the field selection.
  restrictor: string
  // SerpApi's restricted response: exactly what the model received, with
  // no client-side processing in between.
  response: JsonValue
  tokens: number
  // How long this call's SerpApi fetch took, for the optional compare view.
  serpApiMs: number
}

export type Source = {
  label: string
  url: string
}

/**
 * Ground-truth token counts reported by LM Studio's OpenAI-compatible API.
 * These reflect the actual model tokenizer plus per-message role overhead
 * — strictly more accurate than the `Breakdown` estimate.
 */
export type ExactUsage = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/**
 * Per-phase latency. Lets you answer "where did the time go?" with a
 * real breakdown instead of a single elapsed number.
 */
export type Phases = {
  firstInferenceMs: number
  toolExecutionMs: number
  secondInferenceMs: number
}

export type RunQueryResult = {
  // WHY: false when the turn produced no fresh metrics (an error, or the
  //      non-tool-model fast path). The client keeps the previous sidebar
  //      state instead of overwriting it with this result's zeros.
  ok: boolean
  answer: string
  breakdown: Breakdown
  exactUsage: ExactUsage | null
  // WHY: one entry per tool the model invoked. Empty array means the
  //      model answered directly. Multiple entries happen on parallel
  //      tool calls — same shape OpenAI and Anthropic give you.
  toolCalls: Array<ToolCallInfo>
  sources: Array<Source>
  elapsedMs: number
  phases: Phases
  // WHY: ship the conversation back to the client (sans system prompt)
  //      so the next `runQuery` can resend it as `history`. You rebuild
  //      the system prompt on every call so it always reflects today's
  //      date — sending it over the wire would just go stale.
  messages: Array<ChatCompletionMessageParam>
  // NOTE: how many old turns you had to drop to fit inside the model's
  //       context budget. Zero most of the time; surfaces in the UI as
  //       a hint when the conversation starts eating into the sliding
  //       window.
  trimmedTurns: number
  // NOTE: total tokens the conversation occupies right now (tool defs +
  //       system prompt + sanitised history). Powers the "Context used"
  //       hero in the UI — the same number you'd see in LM Studio's own
  //       conversation-tokens counter.
  conversationTokens: number
  // NOTE: the context window LM Studio ACTUALLY loaded for this turn, after
  //       the back-off probe. May be smaller than the size the client asked
  //       for if the machine couldn't fit it. Null when no load was needed
  //       (e.g. LM Studio unreachable). The UI shows this as the real
  //       denominator instead of the optimistic starting guess.
  loadedContext: number | null
}

// WHY: list the segments that make up the model's context window, in the
//      order they're assembled, so the UI can show where every token goes.
export const CONTEXT_SEGMENTS: Array<{
  key: keyof Breakdown
  label: string
  description: string
}> = [
  {
    key: "tool_definitions",
    label: "Tool definitions",
    description: "JSON schema for the SerpApi tools, sent on every call.",
  },
  {
    key: "system_prompt",
    label: "System prompt",
    description:
      "The instructions that set the model's behavior and today's date.",
  },
  {
    key: "conversation_history",
    label: "History",
    description:
      "Previous turns in this chat (user messages, assistant answers, tool results). Grows each turn until trimmed.",
  },
  {
    key: "user_message",
    label: "User message",
    description: "Your question as sent to the model.",
  },
  {
    key: "tool_call",
    label: "Tool call",
    description: "The JSON the model generated to invoke a tool.",
  },
  {
    key: "tool_result",
    label: "Tool result",
    description:
      "SerpApi response (server-side restricted) fed back to the model.",
  },
  {
    key: "final_response",
    label: "Final response",
    description: "The model's final answer to you.",
  },
]

/**
 * Sum every segment in `CONTEXT_SEGMENTS` — the total tokens occupying
 * the model's context window for the turn.
 */
export function contextTotal(breakdown: Breakdown): number {
  return CONTEXT_SEGMENTS.reduce((sum, seg) => sum + breakdown[seg.key], 0)
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
function buildSystemPrompt(): string {
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
- Time-sensitive queries (flight prices, stock prices, news, weather, sports scores, business hours) MUST trigger a fresh tool call every turn — NEVER replay a prior answer from conversation history, even if the question is identical. Stale prices and outdated news are worse than a slightly slower answer.
- When the user asks about multiple entities (compare X and Y, prices of A, B, C), request ALL tool calls in the same turn — one call per entity — instead of chaining them.
- For flights, hotels, maps, and shopping, render the results as a compact markdown table directly from the tool response — one row per item, with the most useful columns first (name, price/rating, key detail). Add one short summary line afterward (cheapest / top pick).
- For flights, always use IATA codes (e.g. SCL, MAD, JFK, LAX).
- For hotels, check_in_date and check_out_date are required (YYYY-MM-DD). If the user gives no dates, pick a reasonable near-future range based on today's date and state which dates you assumed.
- For google_news_search, pass the topic ONLY in \`query\` — never include words like "news", "latest", "últimas". The tool already sorts by recency.
- Localization: when the user writes in a language other than English, set \`hl\` (language code like "es") on every tool that supports it, and \`gl\` (country code like "cl", "es", "mx") on tools that support it. Every tool takes \`hl\`; every tool except finance and flights also takes \`gl\`.
- \`gl\` is ALWAYS a single country (ISO 3166-1 alpha-2: us, gb, de, fr, jp, mx, cl, ...). It is NEVER a region — do not use "eu", "apac", "latam", "emea". If the topic is a region (e.g. "EU AI Act", "European elections", "Asian markets"), either omit \`gl\` or pick one representative country (e.g. "gb" or "de" for European topics).
- If google_news_search returns an empty result set, immediately call google_search with the same topic before giving up. Some subjects (niche tech, B2B products, internal tooling) have no dedicated news coverage but plenty of general web results.
- Cite sources as markdown links: [name](url).
- Do not invent or assume dates. Report only what the results say.
- After receiving tool results, write the final answer in prose. Do not emit additional tool calls.
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
 *      trace each claim back to the exact SERP that produced it —
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

// NOTE: matches the shape of `measurements/benchmark_log.json` from the
//       Python experiment so the analysis scripts you already have work
//       against both versions. The new fields (timestamp, exact_usage,
//       sources_count, phases) are additive.
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
 * Append-only log for local benchmarking. Read-modify-write so the
 * format matches the Python experiment's log; you can run the same
 * analysis scripts against either version.
 *
 * WHY: the whole body is wrapped in try/catch — a logging failure must
 *      never break the user-facing query, no matter what.
 */
async function appendBenchmarkLog(entry: BenchmarkEntry): Promise<void> {
  try {
    await mkdir(dirname(BENCHMARK_LOG_PATH), { recursive: true })
    let existing: Array<BenchmarkEntry> = []
    try {
      const raw = await readFile(BENCHMARK_LOG_PATH, "utf-8")
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) existing = parsed
    } catch {
      // File doesn't exist yet — first entry.
    }
    existing.push(entry)
    await writeFile(
      BENCHMARK_LOG_PATH,
      JSON.stringify(existing, null, 2),
      "utf-8"
    )
  } catch (err) {
    console.error("[benchmark-log] failed to append entry:", err)
  }
}

// ─── Model loading ─────────────────────────────────────
// LM Studio's native API exposes the model list plus a load/unload pair.
// You use both: one to populate the dropdown with metadata, the other to
// reload a running model when the user picks a different context size.

export type ModelInfo = {
  /** Key LM Studio expects in `chat.completions.create({ model })`. */
  id: string
  displayName: string
  arch: string | null
  /** Param string as LM Studio reports it: "9B", "27B", "26B-A4B" (MoE), or null. */
  params: string | null
  maxContextLength: number
  /** Currently loaded instance's context, or null if not loaded yet. */
  currentContextLength: number | null
  toolUseTrained: boolean
  format: "gguf" | "mlx" | null
  /** Computed server-side so you don't redo the math on the client. */
  recommendedContextLength: number
}

// ─── Context sizing ────────────────────────────────────
// You can't predict, from this server, how much memory a model will take —
// it depends on the OS, the quantization, and (on a PC) how much VRAM the
// GPU has versus system RAM. So you don't try. LM Studio ships a memory
// guardrail that estimates the fit (context length + flash attention +
// vision) and BLOCKS a load that won't fit, on REST loads too. You let that
// guardrail be the judge: pick an optimistic starting size, attempt the
// load, and if it's blocked, back off and try smaller. Same code path works
// on a unified-memory Mac and a Windows/Linux box with a discrete GPU.

// Smallest context worth loading — below this a tool call plus its result
// won't fit, so there's no point shrinking further.
const MIN_CONTEXT = 4096
// Round every context size down to this multiple so loaded values read
// cleanly (and the back-off lands on sensible numbers).
const CONTEXT_STEP = 1024
// Optimistic default start for the load probe: a generous 32K window — 8×
// LM Studio's 4K default, plenty for long conversations — that fits the
// common 4–27B models on a 36 GB-class machine. The back-off shrinks it on
// tighter hardware; `LMSTUDIO_CONTEXT_LENGTH` raises it on roomier ones.
const DEFAULT_CONTEXT_CAP = 32768

/**
 * Optimistic STARTING context size for the load probe: the generous default
 * cap, clamped to the model's native max. The back-off in `ensureModelLoaded`
 * shrinks this until LM Studio's guardrail accepts it, so it's a ceiling,
 * not a promise — which is why it no longer guesses from param count.
 */
export function recommendedContext(maxContextLength: number): number {
  return Math.min(DEFAULT_CONTEXT_CAP, maxContextLength)
}

/**
 * Hard override for the loaded context size. Set `LMSTUDIO_CONTEXT_LENGTH`
 * to pin a value and skip the back-off probe — handy when you know exactly
 * what your machine fits. Ignored if unset or below `MIN_CONTEXT`.
 */
export function contextOverride(): number | null {
  const raw = Number(process.env.LMSTUDIO_CONTEXT_LENGTH)
  return Number.isFinite(raw) && raw >= MIN_CONTEXT
    ? Math.floor(raw / CONTEXT_STEP) * CONTEXT_STEP
    : null
}

/**
 * The sizes the load probe will try, largest first: `start` (floored to a
 * clean step), then repeated halving down to `MIN_CONTEXT`. Pure and
 * exported so the back-off schedule can be tested without a live LM Studio.
 */
export function contextBackoffSequence(start: number): Array<number> {
  const seq: Array<number> = []
  let ctx = Math.floor(start / CONTEXT_STEP) * CONTEXT_STEP
  while (ctx >= MIN_CONTEXT) {
    seq.push(ctx)
    ctx = Math.floor(ctx / 2 / CONTEXT_STEP) * CONTEXT_STEP
  }
  return seq
}

/**
 * Every currently-loaded model instance across LM Studio, each as
 * `{ id, model, ctx }`. Empty array if nothing's loaded or LM Studio is
 * unreachable. Never throws.
 */
async function allLoadedInstances(): Promise<
  Array<{ id: string; model: string; ctx: number }>
> {
  try {
    const res = await fetch(`${LM_STUDIO_NATIVE_URL}/models`, {
      signal: AbortSignal.timeout(LM_STUDIO_FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return []
    const payload = (await res.json()) as { models?: Array<LmStudioRawModel> }
    return (payload.models ?? []).flatMap((m) =>
      m.loaded_instances.map((i) => ({
        id: i.id,
        model: m.key,
        ctx: i.config.context_length,
      }))
    )
  } catch {
    return []
  }
}

/**
 * Unload one instance by id. Best-effort — a failure just means the next
 * load may spin up alongside it, which `ensureModelLoaded` re-checks.
 */
async function unloadInstance(id: string): Promise<void> {
  try {
    await fetch(`${LM_STUDIO_NATIVE_URL}/models/unload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instance_id: id }),
      signal: AbortSignal.timeout(LM_STUDIO_FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    devWarn(`[unloadInstance] ${id} failed, continuing:`, err)
  }
}

/**
 * One load attempt at a specific size. Returns true if LM Studio accepted
 * the load, false if its guardrail blocked it (won't fit) or the endpoint
 * errored. Never throws.
 *
 * NOTE: a non-2xx with a memory message is LM Studio refusing an oversized
 *       context — there is no REST "load anyway" override, so a false here
 *       is the signal to back off to a smaller size. The load body carries
 *       ONLY keys this endpoint accepts: `ttl` (and friends) are rejected
 *       with a 400, which would silently fail every load. Idle auto-unload is
 *       therefore handled app-side in `armIdleUnload`, not via a load `ttl`.
 */
async function tryLoadModel(
  model: string,
  contextLength: number
): Promise<boolean> {
  try {
    const res = await fetch(`${LM_STUDIO_NATIVE_URL}/models/load`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        context_length: contextLength,
        flash_attention: true,
      }),
      signal: AbortSignal.timeout(LM_STUDIO_LOAD_TIMEOUT_MS),
    })
    if (!res.ok) {
      devWarn(`[tryLoadModel] ${model}@${contextLength} blocked: ${res.status}`)
      return false
    }
    return true
  } catch (err) {
    devWarn(`[tryLoadModel] ${model}@${contextLength} errored:`, err)
    return false
  }
}

/**
 * Load `model` at a context size that actually fits THIS machine. Strategy:
 * try the requested size; if LM Studio's guardrail blocks it, halve and
 * retry down to `MIN_CONTEXT`. The platform's own estimator is the source
 * of truth, so this is correct on Mac (unified memory) and Windows/Linux
 * (discrete-GPU VRAM) alike.
 *
 * Returns the size LM Studio actually accepted, or null if it couldn't
 * (re)load — in which case the caller keeps whatever was loaded before.
 *
 * NOTE: set `LMSTUDIO_CONTEXT_LENGTH` to pin a size and skip the probe.
 */
async function ensureModelLoaded(
  model: string,
  contextLength: number
): Promise<number | null> {
  const override = contextOverride()
  const target = override ?? contextLength

  const all = await allLoadedInstances()
  const targetInstances = all.filter((i) => i.model === model)
  const others = all.filter((i) => i.model !== model)

  // WHY: this is a one-model-at-a-time chat demo, so free every OTHER model
  //      before loading the selected one. Dedicating memory to the active
  //      model gives the guardrail its full budget — otherwise a model you
  //      tried earlier sits resident and squeezes the new one's context.
  for (const o of others) await unloadInstance(o.id)

  // Already loaded exactly once at the target size → nothing more to do.
  if (targetInstances.length === 1 && targetInstances[0].ctx === target) {
    return target
  }
  // Otherwise start clean: loading without unloading spins up a SECOND
  // instance (LM Studio allows duplicates), so clear stale/duplicate target
  // instances first — `/models/load` won't swap a differently-configured one.
  for (const t of targetInstances) await unloadInstance(t.id)

  // An explicit override means "use exactly this": one attempt, no back-off.
  // If it doesn't fit, fall back rather than silently picking another size.
  if (override !== null) {
    return (await tryLoadModel(model, override)) ? override : null
  }

  for (const ctx of contextBackoffSequence(target)) {
    if (await tryLoadModel(model, ctx)) return ctx
  }
  return null
}

// Single idle-unload timer for the one-model-at-a-time chat. Module-level so it
// survives across `runQuery` calls (the server process is long-lived).
let idleUnloadTimer: ReturnType<typeof setTimeout> | null = null

/**
 * (Re)arm the idle auto-unload timer for `model`. Each query calls this, which
 * resets the countdown — so an active conversation keeps the model resident,
 * and once no query arrives for `LM_STUDIO_IDLE_TTL_SECONDS` the model is
 * unloaded. The next query reloads it through the usual back-off probe. This is
 * the app-side stand-in for LM Studio's JIT idle-TTL, which can't apply to a
 * model we loaded explicitly. Best-effort: a failed unload just leaves the
 * model resident, same as before.
 */
function armIdleUnload(model: string): void {
  if (idleUnloadTimer) clearTimeout(idleUnloadTimer)
  idleUnloadTimer = setTimeout(() => {
    void (async () => {
      for (const inst of await allLoadedInstances()) {
        if (inst.model === model) await unloadInstance(inst.id)
      }
    })()
  }, LM_STUDIO_IDLE_TTL_SECONDS * 1000)
  // Don't let this timer keep the process alive on its own.
  idleUnloadTimer.unref()
}

type LmStudioRawModel = {
  key: string
  display_name: string
  type: "llm" | "embedding"
  architecture: string | null
  params_string: string | null
  max_context_length: number
  format: "gguf" | "mlx" | null
  loaded_instances: Array<{ id: string; config: { context_length: number } }>
  capabilities?: { trained_for_tool_use?: boolean }
}

/**
 * Server function: list every LLM LM Studio knows about, with metadata and
 * a recommended context size.
 */
export const listModels = createServerFn({ method: "GET" }).handler(
  async (): Promise<Array<ModelInfo>> => {
    let res: Response
    try {
      res = await fetch(`${LM_STUDIO_NATIVE_URL}/models`, {
        signal: AbortSignal.timeout(LM_STUDIO_FETCH_TIMEOUT_MS),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new LmStudioError(
        `Can't reach LM Studio at ${LM_STUDIO_NATIVE_URL}: ${msg}`,
        "Is LM Studio running on localhost:1234? Open it → Developer tab → Start Server."
      )
    }
    if (!res.ok) {
      throw new LmStudioError(
        `LM Studio returned ${res.status} on ${LM_STUDIO_NATIVE_URL}/models`,
        "Restart LM Studio's server (Developer tab → Stop → Start) and try again."
      )
    }
    const data = (await res.json()) as { models: Array<LmStudioRawModel> }
    // WHY: LM Studio sometimes lists the same logical model twice (the
    //      GGUF and MLX variants of one release share the `key`). Dedupe
    //      by id or your <Select> will warn about duplicate React keys;
    //      keeping the first entry is fine — the dropdown doesn't care
    //      about format.
    const seen = new Set<string>()
    return data.models
      .filter((m) => m.type === "llm")
      .filter((m) => {
        if (seen.has(m.key)) return false
        seen.add(m.key)
        return true
      })
      .map(
        (m): ModelInfo => ({
          id: m.key,
          displayName: m.display_name,
          arch: m.architecture,
          params: m.params_string,
          maxContextLength: m.max_context_length,
          currentContextLength:
            m.loaded_instances[0]?.config.context_length ?? null,
          toolUseTrained: m.capabilities?.trained_for_tool_use ?? false,
          format: m.format,
          recommendedContextLength: recommendedContext(m.max_context_length),
        })
      )
      .sort((a, b) => a.id.localeCompare(b.id))
  }
)

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
 * unparseable input — when that happens the caller logs and moves on
 * so one bad block doesn't take down the whole turn.
 */
function parseSingleInlineToolCall(body: string): InlineToolCall | null {
  const trimmed = body.trim()

  // Shape 1 — JSON-in-XML.
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

  // Shape 2 — Nested XML.
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
 * Parse every `<tool_call>…</tool_call>` block in a message body into
 * the same shape as OpenAI's structured `tool_calls`. This is what lets
 * you do parallel tool calling on open models that emit calls as text.
 */
export function parseInlineToolCalls(content: string): Array<InlineToolCall> {
  const calls: Array<InlineToolCall> = []
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

/**
 * Strip any `<tool_call>…</tool_call>` fragments — including
 * unterminated ones — from a final answer.
 *
 * WHY: after the second completion you'll occasionally see "I want to
 *      call another tool but I can't" cases where the model emits
 *      trailing XML. Stripping it before showing the answer keeps
 *      parser noise out of the chat.
 */
function stripInlineToolCalls(content: string): string {
  return content
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_call>[\s\S]*$/i, "")
    .trim()
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

// ─── runQuery input + history handling ─────────────────
// The RPC input schema, the sliding-window helper, and the replay
// sanitiser. These are read-and-prep helpers; the orchestration itself
// lives in `runQuery` below.

// WHY: real Zod parsing at the RPC boundary fails fast on garbage from
//      the client (wrong types, missing fields, absurd lengths) — you
//      catch it before spending any inference time on it.
//
// NOTE: `history` is the accumulated conversation from prior turns. The
//       client stores whatever the server returned in `messages` last
//       time and sends it back here. You rebuild the system prompt on
//       every call (so it reflects today's date) and prepend it — no
//       need to ship the prompt over the wire.
const historyMessageSchema = z
  .object({
    role: z.string(),
    content: z.union([z.string(), z.null()]).optional(),
    tool_calls: z.array(z.unknown()).optional(),
    tool_call_id: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough()

const runQueryInput = z.object({
  question: z.string().min(1).max(4000),
  model: z.string().min(1),
  contextLength: z.number().int().positive().optional(),
  toolUseTrained: z.boolean().optional(),
  history: z.array(historyMessageSchema).default([]),
})

const fullResponseInput = z.object({
  name: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
})

// WHY: sliding window — keep the system prompt + tools intact and drop
//      the oldest turns when the conversation won't fit in
//      `contextBudget × ratio`. The 20% headroom is what you reserve for
//      the current user message, new tool calls, tool results, and the
//      final answer.
const HISTORY_FIT_RATIO = 0.8

/**
 * Strip prior tool cycles from history before resending it to the model.
 * Tool-call / tool-result messages are dropped; the assistant turn that
 * relied on them is replaced with a short note.
 *
 * WHY: small models (≤10B) will happily replay a previous turn's
 *      pre-rendered table when you ask the same question twice — stale
 *      flight prices coming back as fresh data. System-prompt rules
 *      don't reliably prevent this. Removing the replayable payload
 *      while keeping the conversational thread intact leaves the model
 *      no choice but to call the tool again for fresh results.
 */
export function sanitizeHistoryForReplay(
  history: Array<ChatCompletionMessageParam>
): Array<ChatCompletionMessageParam> {
  const out: Array<ChatCompletionMessageParam> = []
  const REPLAY_NOTE =
    "[Previously answered using a live tool. Data may be stale — re-run the tool for fresh results.]"
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
      out.push({ role: "assistant", content: REPLAY_NOTE })
      continue
    }
    out.push(m)
  }
  return out
}

/**
 * Drop oldest turns until `staticOverhead + history` fits within the
 * budget. Returns the trimmed array and how many turns you dropped.
 *
 * WHY: always trim from the front. The newest turns carry the context
 *      the user actually cares about; the older ones are the safe ones
 *      to lose.
 */
export function trimHistoryToFit(
  history: Array<ChatCompletionMessageParam>,
  staticOverhead: number,
  contextBudget: number
): { trimmed: Array<ChatCompletionMessageParam>; dropped: number } {
  if (history.length === 0) {
    return { trimmed: history, dropped: 0 }
  }
  const limit = Math.floor(contextBudget * HISTORY_FIT_RATIO)
  const current = [...history]
  let dropped = 0
  while (current.length > 0 && staticOverhead + countTokens(current) > limit) {
    current.shift()
    dropped++
  }
  return { trimmed: current, dropped }
}

export type FullResponseResult = {
  response: JsonValue
  tokens: number
  serpApiMs: number
}

/**
 * Re-run a tool call WITHOUT its restrictor and return the full,
 * untrimmed SerpApi response with its token count and fetch time. Backs
 * the optional "compare the full response" view, which shows how much
 * the restrictor saved — in tokens and in latency — against a live,
 * same-session measurement. The chat loop never calls this; it's a
 * demo-only fetch the user opts into.
 */
export const fetchFullResponse = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => fullResponseInput.parse(data))
  .handler(async ({ data }): Promise<FullResponseResult> => {
    const { name, args } = data
    if (!isRestrictorTool(name)) {
      throw new ToolArgError(
        `Unknown tool: ${name}`,
        "The compare view was asked for a tool the server doesn't know about."
      )
    }
    const validated = validateToolArgs(name, args)
    const start = performance.now()
    const response = await executeToolUnrestricted(name, validated)
    return {
      response: response as JsonValue,
      tokens: countTokens(response),
      serpApiMs: Math.round(performance.now() - start),
    }
  })

/**
 * Run one user query end-to-end on the server.
 *
 * The flow you'll see below: validate input → trim history to fit
 * context → first inference (model picks tools) → execute SerpApi calls
 * in parallel (each pre-trimmed by its restrictor) → second inference
 * (model writes the final answer). Returns the answer plus a token
 * breakdown, per-phase latencies, and tool-call metadata for the UI.
 *
 * Your SerpApi key never leaves this module — the function only runs
 * inside TanStack Start's server boundary.
 */
export const runQuery = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) => runQueryInput.parse(data))
  .handler(async ({ data }): Promise<RunQueryResult> => {
    const start = performance.now()
    const { question, model, contextLength, toolUseTrained, history } = data

    // `effectiveContext` drives history trimming (falls back to the
    // requested size if we can't confirm a load). `loadedContext` is the
    // size LM Studio actually accepted — only set on a real load — and is
    // what the UI shows as the true window. They differ when a load is
    // backed off, or when LM Studio can't be reached at all.
    let effectiveContext = contextLength
    let loadedContext: number | null = null

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
    //      parser will fail silently — better to tell the user up
    //      front than to let them watch a blank loop.
    if (toolUseTrained === false) {
      return {
        ok: false,
        answer:
          "This model isn't trained for tool use, so it can't call SerpApi. Pick a tool-trained model (Qwen 3.x, Llama 3.1/3.2, Mistral) in the dropdown above.",
        breakdown: emptyBreakdown(),
        exactUsage: null,
        toolCalls: [],
        sources: [],
        elapsedMs: Math.round(performance.now() - start),
        phases: emptyPhases(),
        messages: history as Array<ChatCompletionMessageParam>,
        trimmedTurns: 0,
        conversationTokens: 0,
        loadedContext: null,
      }
    }

    try {
      // NOTE: the load probe may shrink the context to fit this machine, so
      //       trim against what LM Studio ACTUALLY loaded — not what the
      //       client asked for — or you'd overflow a window that got backed
      //       off. Silent on failure: older LM Studio without the endpoint
      //       just keeps its current load config.
      if (typeof contextLength === "number") {
        const accepted = await ensureModelLoaded(model, contextLength)
        if (accepted !== null) {
          effectiveContext = accepted
          loadedContext = accepted
        }
      }

      // Reset the idle-unload countdown: this query keeps the model resident,
      // and 5 idle minutes from now (LM_STUDIO_IDLE_TTL_SECONDS) it unloads.
      armIdleUnload(model)

      const client = new OpenAI({
        baseURL: LM_STUDIO_URL,
        apiKey: "lm-studio",
        timeout: LM_STUDIO_CHAT_TIMEOUT_MS,
      })
      const systemPrompt = buildSystemPrompt()

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
        trimHistoryToFit(sanitizedHistory, staticOverhead, budget)

      const messages: Array<ChatCompletionMessageParam> = [
        { role: "system", content: systemPrompt },
        ...trimmedHistory,
        { role: "user", content: question },
      ]

      const breakdown: Breakdown = {
        tool_definitions: toolsTokens,
        system_prompt: systemTokens,
        conversation_history: countTokens(trimmedHistory),
        user_message: questionTokens,
        tool_call: 0,
        tool_result: 0,
        final_response: 0,
      }

      const phases: Phases = emptyPhases()

      // WHY: low temperature on the tool-picking call. Small models
      //      pick tools more reliably when you sample close to
      //      deterministic — keep the creativity for the answer call.
      const t0 = performance.now()
      let first: Awaited<ReturnType<typeof client.chat.completions.create>>
      try {
        first = await client.chat.completions.create({
          model,
          messages,
          tools: TOOLS,
          tool_choice: "auto",
          temperature: 0.1,
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        throw new LmStudioError(
          `LM Studio chat completion failed: ${msg}`,
          "Check that LM Studio is running on :1234 and the selected model is loaded."
        )
      }
      phases.firstInferenceMs = Math.round(performance.now() - t0)
      const msg = first.choices[0].message
      let answer = ""
      const toolCalls: Array<ToolCallInfo> = []
      const rawResults: Array<SerpApiJson> = []
      // NOTE: usage from the final call is ground truth — LM Studio's
      //       own tokenizer, not the cl100k estimate.
      let finalUsage = first.usage

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
      const resolvedCalls: Array<ResolvedCall> = []

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const call of msg.tool_calls) {
          if (call.type !== "function") {
            throw new LmStudioError(
              `Unexpected tool call type: ${call.type}`,
              "The model returned a non-function tool call — this shouldn't happen with OpenAI-compat APIs."
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
          resolvedCalls.push({
            name: call.function.name,
            rawArgs: call.function.arguments,
            args,
            id: call.id,
            isInline: false,
          })
        }
      } else if (msg.content) {
        const inlineCalls = parseInlineToolCalls(msg.content)
        for (const [i, c] of inlineCalls.entries()) {
          resolvedCalls.push({
            name: c.name,
            rawArgs: c.rawArgs,
            args: c.args,
            id: `inline-${Date.now()}-${i}`,
            isInline: true,
          })
        }
      }

      if (resolvedCalls.length > 0) {
        // WHY: validate + execute every call in parallel. This is the
        //      same pattern OpenAI and Anthropic recommend — the model
        //      asks for N things, you run them concurrently, then send
        //      back N results in one shot.
        // NOTE: the phase timer wraps the whole batch — parallel calls
        //       overlap, so summing per-call durations would report more
        //       time than actually passed. Each call's own duration still
        //       ships as `serpApiMs`.
        const toolPhaseStart = performance.now()
        const executed = await Promise.all(
          resolvedCalls.map(async (call) => {
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
            let restrictor = RESTRICTORS[call.name]
            const execStart = performance.now()
            let response = await executeTool(call.name, validated)
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
                const fbResponse = await executeTool("google_search", { query })
                execMs += performance.now() - fbStart
                restrictor = RESTRICTORS.google_search
                response = {
                  ...fbResponse,
                  fallback_from: "google_finance_search",
                  note: `Google Finance had no direct quote for "${query}". These are web search results instead.`,
                }
              }
            }

            return { call, validated, response, restrictor, execMs }
          })
        )
        phases.toolExecutionMs = Math.round(performance.now() - toolPhaseStart)

        for (const r of executed) {
          const responseTokens = countTokens(r.response)
          toolCalls.push({
            name: r.call.name,
            args: r.validated,
            restrictor: r.restrictor,
            response: r.response as JsonValue,
            tokens: responseTokens,
            serpApiMs: Math.round(r.execMs),
          })
          rawResults.push(r.response)
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
          tool_calls: resolvedCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: c.rawArgs },
          })),
        })
        for (const [i, r] of executed.entries()) {
          messages.push({
            role: "tool",
            tool_call_id: resolvedCalls[i].id,
            content: JSON.stringify(r.response),
          })
        }

        // WHY: nudge the temperature up a bit on the answer call so
        //      the response sounds natural without losing determinism.
        const t3 = performance.now()
        let second: Awaited<ReturnType<typeof client.chat.completions.create>>
        try {
          second = await client.chat.completions.create({
            model,
            messages,
            temperature: 0.3,
          })
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err)
          throw new LmStudioError(
            `LM Studio second completion failed: ${m}`,
            "The model loaded but stalled on the answer call — try a smaller context or reload the model."
          )
        }
        phases.secondInferenceMs = Math.round(performance.now() - t3)
        answer = stripInlineToolCalls(second.choices[0].message.content ?? "")
        finalUsage = second.usage

        // WHY: some open models respond to a tool result by emitting
        //      yet another `<tool_call>` block instead of prose. After
        //      you strip that, the answer comes out empty; one more
        //      nudge usually produces clean prose — much cheaper than
        //      returning garbage. The nudge goes through a throwaway
        //      `retryMessages` so it never pollutes the history you
        //      return to the client.
        if (answer.length === 0) {
          const retryMessages: Array<ChatCompletionMessageParam> = [
            ...messages,
            {
              role: "system",
              content:
                "The tool call is complete. Now write the final answer in prose using only the data already returned by the tool. Do NOT emit any more tool calls.",
            },
          ]
          const retryStart = performance.now()
          const retry = await client.chat.completions.create({
            model,
            messages: retryMessages,
            temperature: 0.3,
          })
          phases.secondInferenceMs += Math.round(performance.now() - retryStart)
          answer = stripInlineToolCalls(retry.choices[0].message.content ?? "")
          finalUsage = retry.usage
        }
      } else {
        // No tool call — direct answer. Strip any stray XML in case the
        // model emitted an unparseable fragment.
        answer = stripInlineToolCalls(msg.content ?? "")
      }

      // WHY: last-resort fallback — if the retry above also came back
      //      empty, tell the user explicitly instead of rendering a
      //      blank message.
      if (answer.length === 0) {
        answer =
          "The model returned an empty response after the tool call. Try rephrasing, or pick a different model."
      }

      // WHY: push the final assistant answer onto the conversation so
      //      it appears in history on the next turn — otherwise the
      //      model will forget what it just told the user. Sanitise
      //      first: the occasional invalid UTF-8 byte will crash the
      //      receiving chat template on the next request.
      messages.push({
        role: "assistant",
        content: sanitizeForHistory(answer),
      })

      breakdown.final_response = countTokens(answer)
      // WHY: one source entry per tool call that returned a SerpApi
      //      URL, labelled so you can tell parallel calls apart in the
      //      Sources panel (e.g. "Finance · AAPL" vs "Finance · TSLA").
      const toolSources: Array<{ url: string; label: string }> = []
      for (let i = 0; i < rawResults.length; i++) {
        const url = extractSearchUrl(rawResults[i])
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
        ? {
            promptTokens: finalUsage.prompt_tokens,
            completionTokens: finalUsage.completion_tokens,
            totalTokens: finalUsage.total_tokens,
          }
        : null

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
        success: true,
        response: answer,
      })

      // NOTE: "conversation so far" — what the next call will carry
      //       before you append the next user message. Mirrors LM
      //       Studio's own conversation-tokens counter.
      const nextHistory = messages.slice(1)
      const conversationTokens =
        toolsTokens +
        systemTokens +
        countTokens(sanitizeHistoryForReplay(nextHistory))

      return {
        ok: true,
        answer,
        breakdown,
        exactUsage,
        toolCalls,
        sources,
        elapsedMs,
        phases,
        // NOTE: ship everything except the system prompt (index 0)
        //       back to the client — it'll send it as `history` on
        //       the next call.
        messages: nextHistory,
        trimmedTurns,
        conversationTokens,
        loadedContext,
      }
    } catch (err) {
      const elapsedMs = Math.round(performance.now() - start)
      return {
        ok: false,
        answer: formatAgentError(err),
        breakdown: emptyBreakdown(),
        exactUsage: null,
        toolCalls: [],
        sources: [],
        elapsedMs,
        phases: emptyPhases(),
        // WHY: preserve the existing history on error — you don't
        //      want the user's next attempt to lose all the prior
        //      turns just because one call failed.
        messages: history as Array<ChatCompletionMessageParam>,
        trimmedTurns: 0,
        conversationTokens: 0,
        loadedContext,
      }
    }
  })
