import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"
import { queryOptions } from "@tanstack/react-query"
import { createMiddleware, createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import {
  RESULTS_DIR,
  jobStore,
  jobView,
  launchJob,
  queueRuns,
  stopRuns,
  writeRun,
} from "./bench-job.server"
import type { ToolOutput } from "@/lib/agent-types"
import { PAYLOAD_OUTPUTS, TOOL_OUTPUTS, isToolOutput } from "@/lib/agent-types"
import { buildExamples } from "@/lib/examples"
import { isActiveJob, runFileName } from "@/lib/bench"

// ─── Dev-only benchmark helpers ────────────────────────
// Backs the /bench route. Two tiers: a "payload" tier that only hits
// SerpApi and measures the tool result each output mode would hand the
// model, and an end-to-end tier that runs the full agent loop. Both run as
// a background job on the server (see the bottom of this file). Runs are
// saved to `bench/results/`.
//
// WHY: the route hides itself in production, but TanStack Start server
//      functions are reachable by URL regardless of which route imports
//      them. Every handler here runs through `devOnly`, so a production
//      build refuses to spend SerpApi credits or write to disk even if
//      someone calls the RPC endpoint directly.

const devOnly = createMiddleware({ type: "function" }).server(({ next }) => {
  if (!import.meta.env.DEV) {
    throw new Error(
      "The benchmark endpoints are only available in development."
    )
  }
  return next()
})

// ─── Saved-run schema ──────────────────────────────────
// Everything a reader needs to interpret a number later: the question
// asked, the tool arguments, the mode, the model, and per-completion usage.
// Parsed with Zod on load so an old or hand-edited file fails loudly
// instead of rendering garbage.

export const toolOutputSchema = z.enum(TOOL_OUTPUTS)
const payloadOutputSchema = z.enum(PAYLOAD_OUTPUTS)

const count = z.number().int().nonnegative()

const payloadRowBase = z.object({
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

// ─── Persistence ───────────────────────────────────────

const saveInput = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/),
  run: benchRunSchema,
})

/** Write a run to `bench/results/<timestamp>-<name>.json`. */
export const saveBenchRun = createServerFn({ method: "POST" })
  .middleware([devOnly])
  .validator(saveInput)
  .handler(async ({ data }): Promise<{ file: string }> => {
    const file = runFileName(data.name, new Date())
    await writeRun(file, data.run)
    return { file }
  })

// ─── Legacy (v1) runs ──────────────────────────────────
// The first benchmark page saved a looser shape: payload rows without
// their arguments, and end-to-end cells keyed "mode|label" with optional
// metrics. Upgrade them on read so the numbers stay reachable, filling in
// what v1 never recorded (question text, tool args) from today's fixtures
// and marking anything missing as unavailable rather than zero.

const legacyE2ECellSchema = z.object({
  status: z.enum(["idle", "running", "done", "error"]),
  answer: z.string().optional(),
  error: z.string().optional(),
  toolResultTokens: z.number().optional(),
  promptTokens: z.number().nullable().optional(),
  completionTokens: z.number().nullable().optional(),
  toolCalls: z.array(z.string()).optional(),
  elapsedMs: z.number().optional(),
  phases: z
    .object({
      firstInferenceMs: z.number().optional(),
      toolExecutionMs: z.number().optional(),
      secondInferenceMs: z.number().optional(),
    })
    .optional(),
})

const legacyBenchRunSchema = z.object({
  savedAt: z.string(),
  model: z.string().nullable(),
  payload: z.array(
    payloadRowBase.omit({ args: true }).extend({
      args: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
      tokens: count,
      bytes: count,
      error: z.string().nullable(),
    })
  ),
  e2e: z.record(z.string(), legacyE2ECellSchema.optional()),
})

const roundOrNull = (ms: number | undefined): number | null =>
  ms === undefined ? null : Math.round(ms)

/** Read a v1 run as a current one, or null if it isn't one. Exported for tests. */
export function upgradeLegacyRun(raw: unknown, file: string): BenchRun | null {
  const parsed = legacyBenchRunSchema.safeParse(raw)
  if (!parsed.success) return null
  const legacy = parsed.data
  // v1 never stored the question text; the examples are keyed by the same
  // labels, so recover today's wording and say so.
  const questionByLabel = new Map(
    buildExamples().flatMap((g) => g.items.map((i) => [i.label, i.question]))
  )
  const e2e: Array<E2ECell> = []
  for (const [key, cell] of Object.entries(legacy.e2e)) {
    if (!cell) continue
    const sep = key.indexOf("|")
    const output = key.slice(0, sep)
    const label = key.slice(sep + 1)
    if (!isToolOutput(output)) continue
    const common = {
      label,
      question:
        questionByLabel.get(label) ??
        `(${label} question, not recorded in this run)`,
      output,
      elapsedMs: roundOrNull(cell.elapsedMs),
    }
    if (cell.status === "done") {
      const usage =
        typeof cell.promptTokens === "number" &&
        typeof cell.completionTokens === "number"
          ? {
              promptTokens: cell.promptTokens,
              completionTokens: cell.completionTokens,
              totalTokens: cell.promptTokens + cell.completionTokens,
            }
          : null
      e2e.push({
        status: "completed",
        ...common,
        answer: cell.answer ?? "",
        toolCalls: (cell.toolCalls ?? []).map((name) => ({
          name,
          args: {},
          tokens: null,
          serpApiMs: null,
        })),
        toolResultTokens: cell.toolResultTokens ?? null,
        // v1 only kept the final call's usage, so the turn total is unknown.
        finalUsage: usage,
        totalUsage: null,
        phases: {
          firstInferenceMs: roundOrNull(cell.phases?.firstInferenceMs),
          toolExecutionMs: roundOrNull(cell.phases?.toolExecutionMs),
          secondInferenceMs: roundOrNull(cell.phases?.secondInferenceMs),
        },
        loadedContext: null,
      })
    } else if (cell.status === "error") {
      e2e.push({
        status: "failed",
        ...common,
        error: cell.error ?? "Unknown error (not recorded).",
      })
    }
  }
  return {
    version: 2,
    savedAt: legacy.savedAt,
    name: file
      .replace(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-/, "")
      .replace(/\.json$/, ""),
    model: legacy.model
      ? {
          id: legacy.model,
          params: null,
          arch: null,
          format: null,
          requestedContext: null,
        }
      : null,
    payload: legacy.payload.map((row) =>
      row.error === null
        ? { ...row, error: null, args: row.args ?? {} }
        : { ...row, error: row.error, args: row.args ?? {} }
    ),
    e2e,
  }
}

/**
 * List saved runs, newest first, with their parsed contents. v1 files are
 * upgraded on read; anything that fits neither schema is reported by name
 * so the page can say why it can't be opened.
 */
export const listBenchRuns = createServerFn({ method: "GET" })
  .middleware([devOnly])
  .handler(
    async (): Promise<{
      runs: Array<SavedBenchRun>
      unreadable: Array<string>
    }> => {
      let files: Array<string>
      try {
        files = (await readdir(RESULTS_DIR))
          .filter((f) => f.endsWith(".json"))
          .sort()
          .reverse()
      } catch {
        return { runs: [], unreadable: [] }
      }
      const runs: Array<SavedBenchRun> = []
      const unreadable: Array<string> = []
      for (const file of files) {
        try {
          const raw: unknown = JSON.parse(
            await readFile(join(RESULTS_DIR, file), "utf-8")
          )
          const parsed = benchRunSchema.safeParse(raw)
          if (parsed.success) {
            runs.push({ file, run: parsed.data })
            continue
          }
          const upgraded = upgradeLegacyRun(raw, file)
          if (upgraded) runs.push({ file, run: upgraded })
          else unreadable.push(file)
        } catch {
          unreadable.push(file)
        }
      }
      return { runs, unreadable }
    }
  )

// ─── Background benchmark job ──────────────────────────
// The runner lives in `bench-job.server.ts`; these server functions are the
// page's only way in. See that file for why the run lives on the server.

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

export const startBenchJob = createServerFn({ method: "POST" })
  .middleware([devOnly])
  .validator(startJobInput)
  .handler(({ data }): BenchJob => {
    if (isActiveJob(jobStore.__benchJob)) {
      throw new Error("A benchmark run is already in progress.")
    }
    const job = launchJob(data)
    return jobView() ?? job
  })

/**
 * Queue runs to start one after another, one per model picked. If nothing
 * is running the first one starts now. Returns the run on screen.
 */
export const queueBenchJobs = createServerFn({ method: "POST" })
  .middleware([devOnly])
  .validator(z.array(startJobInput).min(1))
  .handler(({ data }): BenchJob | null => {
    queueRuns(data)
    return jobView()
  })

/** The current or most recent run, or null if none ran since the server started. */
export const getBenchJob = createServerFn({ method: "GET" })
  .middleware([devOnly])
  .handler((): BenchJob | null => {
    return jobView()
  })

/** Stop the running job after the cell in progress and drop the queue. */
export const stopBenchJob = createServerFn({ method: "POST" })
  .middleware([devOnly])
  .handler((): BenchJob | null => {
    stopRuns()
    return jobView()
  })

// The page reads the job and the saved runs through TanStack Query. The
// mutations write the job each server function returns.
export const benchQueries = {
  all: ["bench"] as const,
  job: () =>
    queryOptions({
      queryKey: [...benchQueries.all, "job"] as const,
      queryFn: ({ signal }) => getBenchJob({ signal }),
    }),
  saved: () =>
    queryOptions({
      queryKey: [...benchQueries.all, "saved"] as const,
      queryFn: ({ signal }) => listBenchRuns({ signal }),
    }),
}
