// Dev-only benchmark server functions. Saved runs are read and written in
// `bench-runs.server.ts` and a run executes in `bench-job.server.ts`. Only
// the handlers use those modules, so the client build, which replaces each
// handler with an RPC stub, drops them.

import { queryOptions } from "@tanstack/react-query"
import { createMiddleware, createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import {
  jobStore,
  jobView,
  launchJob,
  queueRuns,
  stopRuns,
} from "./bench-job.server"
import { listSavedRuns, writeRun } from "./bench-runs.server"
import type { BenchJob } from "@/lib/bench-schemas"
import { benchRunSchema, startJobInput } from "@/lib/bench-schemas"
import { isActiveJob, runFileName } from "@/lib/bench"

// ─── Dev-only benchmark helpers ────────────────────────
// Backs the /bench route. Two tiers: a "payload" tier that only hits
// SerpApi and measures the tool result each output mode would hand the
// model, and an end-to-end tier that runs the full agent loop. Both run as
// a background job on the server. Runs are saved to `bench/results/`.
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

/** Saved runs, newest first, and the files that could not be read. */
export const listBenchRuns = createServerFn({ method: "GET" })
  .middleware([devOnly])
  .handler(() => listSavedRuns())

// ─── Background benchmark job ──────────────────────────
// The runner lives in `bench-job.server.ts`; these server functions are the
// page's only way in. See that file for why the run lives on the server.

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
