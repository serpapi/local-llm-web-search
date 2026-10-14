// Browser-safe shapes for the benchmark: the saved-run file format, the
// job a run reports while it goes, and the input that starts one. The
// server parses saved files and validates job input with these schemas;
// the page and `src/lib/bench.ts` use the types inferred from them.

import { z } from "zod"

import type { ToolOutput } from "@/lib/agent-types"
import { PAYLOAD_OUTPUTS, TOOL_OUTPUTS } from "@/lib/agent-types"

// ─── Saved-run schema ──────────────────────────────────
// Everything a reader needs to interpret a number later: the question
// asked, the tool arguments, the mode, the model, and per-completion usage.
// Parsed with Zod on load so an old or hand-edited file fails loudly
// instead of rendering garbage.

export const toolOutputSchema = z.enum(TOOL_OUTPUTS)
const payloadOutputSchema = z.enum(PAYLOAD_OUTPUTS)

const count = z.number().int().nonnegative()

export const payloadRowBase = z.object({
  label: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.union([z.string(), z.number()])),
  output: payloadOutputSchema,
  restrictor: z.string().nullable(),
  serpApiMs: count,
})

// WHY: a measurement that failed has no size. Older files stored 0 there,
//      so the failed shape still accepts a number.
export const payloadMeasurementSchema = z.union([
  payloadRowBase.extend({ error: z.null(), tokens: count, bytes: count }),
  payloadRowBase.extend({
    error: z.string(),
    tokens: count.nullable(),
    bytes: count.nullable(),
  }),
])
export type PayloadMeasurement = z.infer<typeof payloadMeasurementSchema>

const usageSchema = z.object({
  promptTokens: count,
  completionTokens: count,
  totalTokens: count,
})

// Tokens and time are null only in runs upgraded from v1, which recorded
// the tool name alone.
const toolCallSchema = z.object({
  name: z.string(),
  args: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()])
  ),
  tokens: count.nullable(),
  serpApiMs: count.nullable(),
  // The `json_restrictor` the call ran with, null for "Markdown (Raw)".
  // Absent in older runs.
  restrictor: z.string().nullable().optional(),
})

// Null only in runs upgraded from v1, which did not always record it.
const elapsedMsSchema = count.nullable()

// WHY: a discriminated union per outcome. A completed cell always has its
//      measurements; a failed cell always has a reason. The compiler
//      rejects a "done cell with no numbers" that a status + optional
//      fields shape would let through.
export const e2eCellSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("completed"),
    label: z.string(),
    question: z.string(),
    output: toolOutputSchema,
    answer: z.string(),
    toolCalls: z.array(toolCallSchema),
    toolResultTokens: count.nullable(),
    // Final-call usage (context the model read to write the answer).
    finalUsage: usageSchema.nullable(),
    // Sum across every completion in the turn. Null when incomplete.
    totalUsage: usageSchema
      .extend({ completions: z.number().int() })
      .nullable(),
    elapsedMs: elapsedMsSchema,
    // v1 never timed the SerpApi call, so its runs have null there.
    phases: z.object({
      firstInferenceMs: count.nullable(),
      toolExecutionMs: count.nullable(),
      secondInferenceMs: count.nullable(),
    }),
    loadedContext: z.number().int().positive().nullable(),
    // What LM Studio applied, when it said. Absent in older runs.
    appliedContext: z.number().int().positive().nullable().optional(),
    // The answer call came back empty and was asked again. Absent in runs
    // saved before this field existed.
    retried: z.boolean().optional(),
    // Tool rounds, 0 to 3. Older runs allowed at most 2.
    // Absent in older runs.
    toolRounds: z.number().int().nonnegative().optional(),
    // The answer stopped at the completion cap. Absent in older runs.
    cutOff: z.boolean().optional(),
  }),
  z.object({
    status: z.literal("failed"),
    label: z.string(),
    question: z.string(),
    output: toolOutputSchema,
    error: z.string(),
    elapsedMs: elapsedMsSchema,
    // What the turn did before it failed, so the inspector can show the
    // searches the model ran and its own last words. Absent in older runs.
    toolCalls: z.array(toolCallSchema).optional(),
    rawReply: z.string().nullable().optional(),
  }),
])
export type E2ECell = z.infer<typeof e2eCellSchema>

export const benchRunSchema = z.object({
  version: z.literal(2),
  savedAt: z.string(),
  name: z.string(),
  model: z
    .object({
      id: z.string(),
      params: z.string().nullable(),
      arch: z.string().nullable(),
      format: z.enum(["gguf", "mlx"]).nullable(),
      // Null in runs upgraded from v1, which saved only the model id.
      requestedContext: z.number().int().positive().nullable(),
    })
    .nullable(),
  payload: z.array(payloadMeasurementSchema),
  e2e: z.array(e2eCellSchema),
})
export type BenchRun = z.infer<typeof benchRunSchema>

/** A run that has been saved to disk, with its file name. */
export type SavedBenchRun = { file: string; run: BenchRun }

// ─── Payload tier ──────────────────────────────────────

export const payloadInput = z.object({
  label: z.string().min(1),
  name: z.string().min(1),
  args: z.record(z.string(), z.union([z.string(), z.number()])).default({}),
})

// ─── Background benchmark job ──────────────────────────
// What a run reports while it goes, and the input that starts one. The
// runner lives in `src/server/bench-job.server.ts`.

export type BenchJob = {
  id: string
  tier: "payload" | "e2e"
  status: "running" | "stopping" | "done" | "stopped" | "error"
  name: string
  file: string
  startedAt: string
  current: string | null
  done: number
  total: number
  error: string | null
  // The modes and question labels picked when the run started, so a page
  // that reloads mid-run shows them instead of the defaults.
  modes: Array<ToolOutput>
  labels: Array<string>
  // Models queued to run after this one, in order.
  next: Array<string>
  run: BenchRun
}

export const modelMetaSchema = z.object({
  id: z.string(),
  params: z.string().nullable(),
  arch: z.string().nullable(),
  format: z.enum(["gguf", "mlx"]).nullable(),
  requestedContext: z.number().int().positive(),
  toolUseTrained: z.boolean().nullable(),
})

export const startJobInput = z.discriminatedUnion("tier", [
  z.object({
    tier: z.literal("payload"),
    name: z.string().regex(/^[a-z0-9-]*$/),
    model: modelMetaSchema.nullable(),
    calls: z.array(payloadInput).min(1),
    // End-to-end cells already on screen, kept in the same file.
    keepE2E: z.array(e2eCellSchema).default([]),
    // The page's end-to-end selections, restored after a reload.
    modes: z.array(toolOutputSchema).default([]),
    labels: z.array(z.string()).default([]),
  }),
  z.object({
    tier: z.literal("e2e"),
    name: z.string().regex(/^[a-z0-9-]*$/),
    model: modelMetaSchema,
    modes: z.array(toolOutputSchema).min(1),
    questions: z
      .array(z.object({ label: z.string(), question: z.string() }))
      .min(1),
    // Payload rows already on screen, kept in the same file.
    keepPayload: z.array(payloadMeasurementSchema).default([]),
  }),
])

export type StartJobInput = z.infer<typeof startJobInput>
