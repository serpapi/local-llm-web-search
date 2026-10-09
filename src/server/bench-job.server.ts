// Server-only benchmark job runner. The `.server.ts` suffix tells TanStack
// Start's import protection to keep this file (and the tokenizer and agent
// loop it reaches) out of the browser bundle. `bench.ts` exposes it to the
// page through thin server functions.

import { mkdir, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  executeTool,
  hasInlineToolCall,
  restrictorFor,
  runAgentTurn,
  validateToolArgs,
} from "./agent"
import { isRestrictorTool } from "./restrictors"
import { countTokens } from "./tokens.server"
import type { z } from "zod"
import type {
  BenchJob,
  BenchRun,
  E2ECell,
  PayloadMeasurement,
  StartJobInput,
  modelMetaSchema,
  payloadInput,
} from "./bench"
import type { ToolOutput } from "@/lib/agent-types"
import { MAX_COMPLETION_TOKENS, PAYLOAD_OUTPUTS } from "@/lib/agent-types"
import { interleaveCells, isActiveJob, runFileName } from "@/lib/bench"

/** Where runs are saved, relative to the project root. */
export const RESULTS_DIR = "bench/results"

// ─── Background benchmark job ──────────────────────────
// WHY: the browser used to drive the run cell by cell. A page reload, a
//      Vite HMR update or a closed tab lost the run state, so the UI could
//      neither show nor stop a run that was still going. The run now lives
//      on the server: the page starts it, polls `getBenchJob` for progress,
//      and asks `stopBenchJob` to stop it. Results are written to disk after
//      every cell, so even a server restart keeps what finished.
//
//      State sits on `globalThis` so a Vite HMR reload of this module keeps
//      pointing at the same in-flight job instead of forgetting it.

export const jobStore = globalThis as typeof globalThis & {
  __benchJob?: BenchJob | null
  __benchStop?: boolean
  __benchQueue?: Array<StartJobInput>
  __benchQueueTimer?: ReturnType<typeof setInterval>
}

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

async function measureOne(
  call: z.infer<typeof payloadInput>
): Promise<Array<PayloadMeasurement>> {
  const { label, name, args } = call
  if (!isRestrictorTool(name)) throw new Error(`Unknown tool: ${name}`)
  const validated = validateToolArgs(name, args)
  return Promise.all(
    PAYLOAD_OUTPUTS.map(async (output): Promise<PayloadMeasurement> => {
      const full = output === "json-full"
      const base = {
        label,
        tool: name,
        args,
        output,
        restrictor: full ? null : restrictorFor(name, output),
      }
      const start = performance.now()
      try {
        const { payload } = full
          ? await executeTool(name, validated, "json", false)
          : await executeTool(name, validated, output)
        const text =
          typeof payload === "string" ? payload : JSON.stringify(payload)
        return {
          ...base,
          tokens: countTokens(payload),
          bytes: new TextEncoder().encode(text).length,
          serpApiMs: Math.round(performance.now() - start),
          error: null,
        }
      } catch (err) {
        return {
          ...base,
          tokens: null,
          bytes: null,
          serpApiMs: Math.round(performance.now() - start),
          error: err instanceof Error ? err.message : String(err),
        }
      }
    })
  )
}

/**
 * Say why a turn ended without an answer, in terms of what the model did.
 * Exported for tests.
 */
export function describeMissingAnswer(
  rawReply: string | null,
  cutOff = false
): string {
  if (rawReply && hasInlineToolCall(rawReply)) {
    return "The model kept asking for another search instead of answering, even after the last round and a retry."
  }
  if (rawReply && rawReply.trim().length > 0) {
    return "The model's reply had no usable answer after the tool call."
  }
  if (cutOff) {
    return `The model used its whole ${MAX_COMPLETION_TOKENS.toLocaleString("en-US")}-token budget reasoning and wrote no answer, even after a retry.`
  }
  return "The model returned an empty reply after the tool call, even after a retry."
}

async function runE2ECell(
  model: z.infer<typeof modelMetaSchema>,
  mode: ToolOutput,
  q: { label: string; question: string }
): Promise<E2ECell> {
  const started = performance.now()
  try {
    const r = await runAgentTurn({
      question: q.question,
      model: model.id,
      contextLength: model.requestedContext,
      toolUseTrained: model.toolUseTrained ?? undefined,
      history: [],
      toolOutput: mode,
    })
    const base = { label: q.label, question: q.question, output: mode }
    const toolCalls = r.toolCalls.map((t) => ({
      name: t.name,
      args: t.args,
      tokens: t.tokens,
      serpApiMs: t.serpApiMs,
      restrictor: t.restrictor,
    }))
    if (r.ok && !r.answerMissing) {
      return {
        ...base,
        status: "completed",
        answer: r.answer,
        toolCalls,
        toolResultTokens: r.breakdown.tool_result,
        finalUsage: r.exactUsage,
        totalUsage: r.totalUsage,
        elapsedMs: r.elapsedMs,
        phases: r.phases,
        loadedContext: r.loadedContext,
        appliedContext: r.appliedContext,
        retried: r.retried,
        toolRounds: r.toolRounds,
        cutOff: r.cutOff,
      }
    }
    return {
      ...base,
      status: "failed",
      error: r.ok
        ? describeMissingAnswer(r.rawReply, r.cutOff)
        : r.answer.replace(/\*\*Error:\*\*\s*/g, "").trim(),
      elapsedMs: r.elapsedMs,
      toolCalls,
      rawReply: r.rawReply,
    }
  } catch (err) {
    return {
      label: q.label,
      question: q.question,
      output: mode,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      elapsedMs: Math.round(performance.now() - started),
    }
  }
}

async function driveJob(job: BenchJob, input: StartJobInput): Promise<void> {
  try {
    if (input.tier === "payload") {
      for (const call of input.calls) {
        if (jobStore.__benchStop) break
        job.current = call.label
        const rows = await measureOne(call)
        job.run = { ...job.run, payload: [...job.run.payload, ...rows] }
        job.done++
        await writeRun(job.file, job.run)
      }
    } else {
      // Question by question, every mode back to back, so a slow stretch
      // on the machine hits every mode instead of landing on one.
      const cells = interleaveCells(input.questions, input.modes)
      for (const { mode, q } of cells) {
        if (jobStore.__benchStop) break
        job.current = `${mode}|${q.label}`
        const cell = await runE2ECell(input.model, mode, q)
        job.run = { ...job.run, e2e: [...job.run.e2e, cell] }
        job.done++
        await writeRun(job.file, job.run)
      }
    }
    job.status = jobStore.__benchStop ? "stopped" : "done"
  } catch (err) {
    job.status = "error"
    job.error = err instanceof Error ? err.message : String(err)
  } finally {
    job.current = null
    jobStore.__benchStop = false
  }
}

/**
 * Queue runs to start one after another. If nothing is running the first
 * one starts now; the rest wait in `queue()`.
 */
export function queueRuns(runs: Array<StartJobInput>): {
  started: string | null
  waiting: number
} {
  const pending = [...runs]
  let started: string | null = null
  if (!isActiveJob(jobStore.__benchJob)) {
    const first = pending.shift()
    if (first) started = launchJob(first).file
  }
  queue().push(...pending)
  if (queue().length > 0) watchQueue()
  return { started, waiting: queue().length }
}

/** The record for a run about to start. Exported for tests. */
export function createJob(data: StartJobInput, start: Date): BenchJob {
  const startedAt = start.toISOString()
  const name = data.name || "run"
  const file = runFileName(name, start)
  return {
    id: file.replace(/\.json$/, ""),
    tier: data.tier,
    status: "running",
    name,
    file,
    startedAt,
    current: null,
    done: 0,
    total:
      data.tier === "payload"
        ? data.calls.length
        : data.questions.length * data.modes.length,
    error: null,
    modes: data.modes,
    next: [],
    labels:
      data.tier === "payload"
        ? data.labels
        : data.questions.map((q) => q.label),
    run: {
      version: 2,
      savedAt: startedAt,
      name,
      model: data.model
        ? {
            id: data.model.id,
            params: data.model.params,
            arch: data.model.arch,
            format: data.model.format,
            requestedContext: data.model.requestedContext,
          }
        : null,
      payload: data.tier === "e2e" ? data.keepPayload : [],
      e2e: data.tier === "payload" ? data.keepE2E : [],
    },
  }
}

export function launchJob(data: StartJobInput): BenchJob {
  const job = createJob(data, new Date())
  jobStore.__benchStop = false
  jobStore.__benchJob = job
  // Fire and forget: the request returns now, the run keeps going.
  void driveJob(job, data)
  return job
}

/**
 * The current or most recent run, with the models queued after it, or null
 * if nothing ran since the server started.
 */
export function jobView(): BenchJob | null {
  const job = jobStore.__benchJob
  if (!job) return null
  return { ...job, next: queue().map((r) => r.model?.id ?? "no model") }
}

// Runs waiting their turn, started one after another when the current run
// ends. Lets you queue several models and leave them overnight.
export function queue(): Array<StartJobInput> {
  jobStore.__benchQueue ??= []
  return jobStore.__benchQueue
}

const QUEUE_POLL_MS = 3_000

function stopWatchingQueue(): void {
  clearInterval(jobStore.__benchQueueTimer)
  jobStore.__benchQueueTimer = undefined
}

// WHY: the queue watches the job instead of hooking the end of `driveJob`,
//      so it also picks up after a run started before the queue existed or
//      by an older copy of this module (Vite HMR swaps modules mid-run).
//      One timer on `globalThis`, so an HMR reload never starts a second.
function watchQueue(): void {
  if (jobStore.__benchQueueTimer) return
  jobStore.__benchQueueTimer = setInterval(() => {
    if (isActiveJob(jobStore.__benchJob)) return
    const next = queue().shift()
    if (next) launchJob(next)
    if (queue().length === 0) stopWatchingQueue()
  }, QUEUE_POLL_MS)
}

/**
 * Stop the running job after its current cell and drop every queued run.
 * WHY: the queue is cleared here, not when the run ends, so a Stop pressed
 *      in the gap between two queued runs, or before a run started by hand
 *      finishes, never lets the old queue resume.
 */
export function stopRuns(): BenchJob | null {
  queue().length = 0
  stopWatchingQueue()
  const job = jobStore.__benchJob ?? null
  if (job?.status === "running") {
    jobStore.__benchStop = true
    job.status = "stopping"
  }
  return job
}
