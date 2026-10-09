// ─── Shared agent types and constants ──────────────────
// Everything in this file is safe to import from the browser: plain types
// and a few constant tables the chat and benchmark pages render from.
//
// WHY: `src/server/agent.ts` also pulls in js-tiktoken (a 5.6 MB encoder
//      table), the SerpApi SDK and the OpenAI client at module scope. A
//      client component that value-imported a constant from that module
//      dragged the whole thing into the browser bundle. Keeping the shared
//      surface here means the routes import types and constants from a
//      module with zero server dependencies, and only call the server
//      functions through TanStack Start's RPC boundary.

/**
 * Which SerpApi output the model receives as a tool result.
 *
 * - `json`: the classic structured response (`output=json`), fetched with
 *   the SDK's `getJson`.
 * - `markdown`: SerpApi's Markdown output (`output=md`) with the same
 *   `json_restrictor` as JSON, so only the serialisation differs. See
 *   https://serpapi.com/markdown-output.
 * - `markdown-full`: the same Markdown output with no `json_restrictor`,
 *   so the model reads the complete document SerpApi renders.
 */
export type ToolOutput = "json" | "markdown" | "markdown-full"

// Ceiling on generated tokens per completion, reasoning included. It was
// 1,500 until 2026-10-02: on October 1 that cut 13 answers short, all in
// Markdown modes, and six came back empty because the model spent the whole
// budget thinking. The system prompt, not this cap, keeps answers short.
export const MAX_COMPLETION_TOKENS = 4096

export const TOOL_OUTPUTS = ["json", "markdown", "markdown-full"] as const

/** Display copy for each output mode, shared by the chat composer and /bench. */
export const TOOL_OUTPUT_META: Record<
  ToolOutput,
  { label: string; short: string; description: string }
> = {
  json: {
    label: "JSON (Restrictor)",
    short: "JSON",
    description: "Structured SerpApi response, trimmed by the JSON Restrictor",
  },
  markdown: {
    label: "Markdown (Restrictor)",
    short: "Markdown",
    description:
      "SerpApi Markdown output, more fields at about the JSON token count",
  },
  "markdown-full": {
    label: "Markdown (Raw)",
    short: "Raw",
    description: "SerpApi Markdown output with no restrictor",
  },
}

export function isToolOutput(value: unknown): value is ToolOutput {
  return (TOOL_OUTPUTS as ReadonlyArray<unknown>).includes(value)
}

/**
 * The payload tier measures one extra shape the model never receives:
 * `json-full`, the complete structured response with no restrictor. It is
 * the reference for how much the restrictor removes.
 */
export type PayloadOutput = "json-full" | ToolOutput

export const PAYLOAD_OUTPUTS = ["json-full", ...TOOL_OUTPUTS] as const

export const PAYLOAD_OUTPUT_META: Record<
  PayloadOutput,
  { label: string; short: string; description: string }
> = {
  "json-full": {
    label: "JSON (Raw)",
    short: "Raw JSON",
    description: "Structured SerpApi response with no restrictor",
  },
  ...TOOL_OUTPUT_META,
}

// WHY: tool args are always JSON primitives. The Zod schemas only accept
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
  // The `json_restrictor` string that produced `response`. Shown in the
  // tool-call dialog as the literal request that did the field selection.
  // `null` when the call ran without a restrictor (`markdown-full`).
  restrictor: string | null
  // Which SerpApi output this call used. Tells the UI whether `response`
  // is a JSON tree or a Markdown string.
  output: ToolOutput
  // SerpApi's restricted response: exactly what the model received, with
  // no client-side processing in between (JSON tree, or Markdown text).
  response: JsonValue
  tokens: number
  // How long this call's SerpApi fetch took, for the optional compare view.
  serpApiMs: number
  // Which search round of the turn ran this call, from 1. Calls in the same
  // round ran in parallel. Missing on turns saved before it existed.
  round?: number
}

export type Source = {
  label: string
  url: string
}

/**
 * Ground-truth token counts reported by LM Studio's OpenAI-compatible API.
 * These reflect the actual model tokenizer plus per-message role overhead,
 * strictly more accurate than the `Breakdown` estimate.
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

export type QueryProgress = {
  stage: "load" | "think" | "tools" | "answer"
  // Extra context for the stage. For "tools", the engines being called.
  detail: string | null
}

export type FullResponseResult = {
  response: JsonValue
  tokens: number
  serpApiMs: number
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
      "Your earlier questions and the model's answers, without tool calls or results.",
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
 * Sum every segment in `CONTEXT_SEGMENTS`: the total tokens occupying
 * the model's context window for the turn.
 */
export function contextTotal(breakdown: Breakdown): number {
  return CONTEXT_SEGMENTS.reduce((sum, seg) => sum + breakdown[seg.key], 0)
}
