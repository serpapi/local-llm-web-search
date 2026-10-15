// Saved benchmark runs on disk. The `.server.ts` suffix keeps this file out
// of the client build. It writes a run without ever leaving a half-written
// file, and reads every run back, upgrading the files the first benchmark
// page saved. `bench.functions.ts` and the runner in `bench-job.server.ts`
// call it.

import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

import type { BenchRun, E2ECell, SavedBenchRun } from "@/lib/bench-schemas"
import { benchRunSchema, payloadRowBase } from "@/lib/bench-schemas"
import { isToolOutput } from "@/lib/agent-types"
import { buildExamples } from "@/lib/examples"

/** Where runs are saved, relative to the project root. */
export const RESULTS_DIR = "bench/results"

/**
 * Write a file through a temp file in the same directory and a rename, so
 * a server killed mid-write leaves the old file whole instead of truncated.
 */
export async function writeFileAtomic(
  path: string,
  content: string
): Promise<void> {
  const temp = `${path}.${process.pid}-${Date.now()}.tmp`
  try {
    await writeFile(temp, content, "utf-8")
    await rename(temp, path)
  } catch (err) {
    await rm(temp, { force: true })
    throw err
  }
}

/** Write a run to `bench/results/<file>`, stamped with the current time. */
export async function writeRun(file: string, run: BenchRun): Promise<void> {
  await mkdir(RESULTS_DIR, { recursive: true })
  await writeFileAtomic(
    join(RESULTS_DIR, file),
    JSON.stringify({ ...run, savedAt: new Date().toISOString() }, null, 2) +
      "\n"
  )
}

// ─── Legacy (v1) runs ──────────────────────────────────
// The first benchmark page saved a looser shape: payload rows without
// their arguments, and end-to-end cells keyed "mode|label" with optional
// metrics. Upgrade them on read so the numbers stay reachable, filling in
// what v1 never recorded (question text, tool args) from today's fixtures
// and marking anything missing as unavailable rather than zero.

const count = z.number().int().nonnegative()

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
 * so the page can say why it can't be opened. No results folder means no
 * runs yet; any other error reading it is thrown.
 */
export async function listSavedRuns(): Promise<{
  runs: Array<SavedBenchRun>
  unreadable: Array<string>
}> {
  let files: Array<string>
  try {
    files = (await readdir(RESULTS_DIR))
      .filter((f) => f.endsWith(".json"))
      .sort()
      .reverse()
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return { runs: [], unreadable: [] }
    }
    throw err
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
