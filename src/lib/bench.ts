// ─── Benchmark model (browser-safe) ────────────────────
// Pure data and math for the /bench page: which tool calls the payload tier
// measures, and how a set of measurements rolls up into the numbers the
// page shows. No server imports, so the route can use it freely.

import type { PayloadOutput, ToolOutput } from "@/lib/agent-types"
import type { BenchJob, E2ECell, PayloadMeasurement } from "@/server/bench"
import { PAYLOAD_OUTPUTS } from "@/lib/agent-types"

export type ActiveBenchJob = BenchJob & { status: "running" | "stopping" }

/** True while a job is running or finishing its current cell. */
export function isActiveJob(
  job: BenchJob | null | undefined
): job is ActiveBenchJob {
  return job?.status === "running" || job?.status === "stopping"
}

/** A run's file name: its start time, file-safe and sortable, then its name. */
/**
 * The name of one queued run when several models run one after another:
 * the run name, if any, then the model, so each file says which model it
 * holds.
 */
export function queuedRunName(name: string, modelId: string): string {
  const model = (modelId.split("/").pop() ?? modelId)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  return name ? `${name}-${model}` : model
}

export function runFileName(name: string, startedAt: Date): string {
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-").slice(0, 19)
  return `${stamp}-${name}.json`
}

export type PayloadCall = {
  label: string
  name: string
  args: Record<string, string | number>
}

// A flight date two months out and a three-night hotel stay on the same
// horizon, mirroring `buildExamples()` so the payload tier and the end-to-end
// tier ask SerpApi about the same trip.
function tripDates(): { out: string; checkOut: string } {
  const d = new Date()
  d.setMonth(d.getMonth() + 2)
  const out = d.toISOString().slice(0, 10)
  const co = new Date(d)
  co.setDate(co.getDate() + 3)
  return { out, checkOut: co.toISOString().slice(0, 10) }
}

/**
 * The tool call each live-data example resolves to, so the payload tier
 * can hit SerpApi without asking the model to pick arguments.
 */
export function payloadCalls(): Array<PayloadCall> {
  const { out, checkOut } = tripDates()
  return [
    {
      label: "Search",
      name: "google_search",
      args: { query: "Who is the current CEO of Apple?" },
    },
    {
      label: "Finance",
      name: "google_finance_search",
      args: { query: "NVDA:NASDAQ" },
    },
    {
      label: "News",
      name: "google_news_search",
      args: { query: "EU AI Act", hl: "en" },
    },
    {
      label: "Maps",
      name: "google_maps_search",
      args: {
        query: "best barbecue restaurants in Austin, Texas",
        gl: "us",
        hl: "en",
      },
    },
    {
      label: "Flights",
      name: "google_flights_search",
      args: {
        departure_id: "JFK",
        arrival_id: "LAX",
        outbound_date: out,
        hl: "en",
      },
    },
    {
      label: "Hotels",
      name: "google_hotels_search",
      args: {
        query: "hotels in Barcelona",
        check_in_date: out,
        check_out_date: checkOut,
        adults: 2,
        gl: "es",
        hl: "en",
      },
    },
    {
      label: "Shopping",
      name: "google_shopping_search",
      args: { query: "AirPods Pro", gl: "us", hl: "en" },
    },
  ]
}

/**
 * The order end-to-end cells run in: question by question, every mode back
 * to back. A slow stretch on the machine then hits every mode equally
 * instead of landing on whichever mode ran during it.
 */
export function interleaveCells<TQuestion>(
  questions: ReadonlyArray<TQuestion>,
  modes: ReadonlyArray<ToolOutput>
): Array<{ mode: ToolOutput; q: TQuestion }> {
  return questions.flatMap((q) => modes.map((mode) => ({ mode, q })))
}

export function cellKey(output: PayloadOutput, label: string): string {
  return `${output}|${label}`
}

/** Index a flat list of measurements by (mode, label). */
export function indexPayload(
  rows: Array<PayloadMeasurement>
): Map<string, PayloadMeasurement> {
  return new Map(rows.map((r) => [cellKey(r.output, r.label), r]))
}

export function indexCells(cells: Array<E2ECell>): Map<string, E2ECell> {
  return new Map(cells.map((c) => [cellKey(c.output, c.label), c]))
}

/**
 * Relative change of `value` against `baseline`, or `null` when either side
 * is missing or zero. Callers render null as "not comparable" rather than
 * inventing a number.
 */
export function relativeChange(
  value: number | undefined,
  baseline: number | undefined
): number | null {
  if (value === undefined || baseline === undefined || baseline === 0)
    return null
  return (value - baseline) / baseline
}

/** Format a relative change as a signed percentage, or a multiplier past 2×. */
export function formatChange(change: number | null): string {
  if (change === null) return "–"
  const ratio = 1 + change
  if (ratio >= 2) return `${ratio.toFixed(1)}×`
  const pct = Math.round(change * 100)
  return `${pct > 0 ? "+" : ""}${pct}%`
}

export function formatTokens(n: number | null | undefined): string {
  return n === null || n === undefined ? "–" : n.toLocaleString("en-US")
}

export function formatSeconds(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–"
  const s = ms / 1000
  return s >= 100 ? `${Math.round(s)} s` : `${s.toFixed(1)} s`
}

export function formatKb(bytes: number | null): string {
  return bytes === null ? "–" : `${(bytes / 1024).toFixed(1)} KB`
}

/** A measurement's token count, or undefined when it is missing or failed. */
export function measuredTokens(
  row: PayloadMeasurement | undefined
): number | undefined {
  return row?.error === null ? row.tokens : undefined
}

/** Per-mode totals over the payload tier, only counting successful rows. */
export function payloadTotals(
  rows: Array<PayloadMeasurement>
): Record<PayloadOutput, { tokens: number; count: number; errors: number }> {
  const out = Object.fromEntries(
    PAYLOAD_OUTPUTS.map((m) => [m, { tokens: 0, count: 0, errors: 0 }])
  ) as Record<PayloadOutput, { tokens: number; count: number; errors: number }>
  for (const r of rows) {
    if (r.error === null) {
      out[r.output].tokens += r.tokens
      out[r.output].count++
    } else out[r.output].errors++
  }
  return out
}

/**
 * The usage figure a cell contributes to comparisons. Prefers the turn
 * total; falls back to the final-call usage (all v1 runs recorded) and says
 * so, so a mixed table never silently compares different quantities.
 */
export function usageOf(cell: E2ECell): {
  promptTokens: number
  completionTokens: number
  basis: "turn" | "final-call"
} | null {
  if (cell.status !== "completed") return null
  if (cell.totalUsage)
    return {
      promptTokens: cell.totalUsage.promptTokens,
      completionTokens: cell.totalUsage.completionTokens,
      basis: "turn",
    }
  if (cell.finalUsage)
    return {
      promptTokens: cell.finalUsage.promptTokens,
      completionTokens: cell.finalUsage.completionTokens,
      basis: "final-call",
    }
  return null
}

/**
 * A one-sentence reading of a failed cell's error for the matrix. LM Studio
 * errors arrive as nested JSON; the inspector still shows the full text.
 */
export function failureLabel(error: string): string {
  const size = error.match(
    /request \((\d+) tokens\) exceeds the available context size \((\d+) tokens\)/
  )
  if (size) {
    return `The prompt (${formatTokens(Number(size[1]))} tokens) is over the ${formatTokens(Number(size[2]))}-token context.`
  }
  const own = error.match(
    /The prompt \([\d,]+ tokens\) is over the [\d,]+-token context/
  )
  if (own) return `${own[0]}.`
  if (/does not match the expected .*format/i.test(error)) {
    return "LM Studio could not parse the model's output."
  }
  return error
}

// The earlier completion cap, for runs saved without `cutOff`.
const LEGACY_COMPLETION_CAP = 1500

/**
 * True when the answer stopped at the completion cap, so it is cut off.
 * Newer runs record LM Studio's finish reason; older ones are judged by
 * the 1,500-token cap they ran under (LM Studio reports 1,499 or 1,500).
 */
export function hitCompletionCap(cell: E2ECell): boolean {
  if (cell.status !== "completed") return false
  if (cell.cutOff !== undefined) return cell.cutOff
  if (!cell.finalUsage) return false
  return cell.finalUsage.completionTokens >= LEGACY_COMPLETION_CAP - 1
}

/**
 * True when the answer call read more tokens than the context the model was
 * loaded with. LM Studio's MLX engine runs such prompts anyway (Qwen took
 * 62,657 tokens at a 32,768 load), while GGUF models reject them, so the
 * cell would have failed on a model that enforces the limit.
 */
export function exceedsContext(cell: E2ECell): boolean {
  if (cell.status !== "completed" || !cell.finalUsage || !cell.loadedContext)
    return false
  return cell.finalUsage.promptTokens > cell.loadedContext
}

export type E2ESummary = {
  completed: number
  failed: number
  // Summed only over completed cells that reported a total; null when none.
  promptTokens: number | null
  completionTokens: number | null
  elapsedMs: number
  usageMissing: number
  // How many counted cells only had final-call usage (older runs).
  finalCallOnly: number
}

/** Per-mode roll-up of end-to-end cells. */
export function e2eSummary(
  cells: Array<E2ECell>,
  output: ToolOutput
): E2ESummary {
  const mine = cells.filter((c) => c.output === output)
  let completed = 0
  let failed = 0
  let elapsedMs = 0
  let prompt = 0
  let completion = 0
  let counted = 0
  let usageMissing = 0
  let finalCallOnly = 0
  for (const c of mine) {
    // Runs from the first benchmark page did not always record a time.
    elapsedMs += c.elapsedMs ?? 0
    if (c.status === "failed") {
      failed++
      continue
    }
    completed++
    const u = usageOf(c)
    if (u) {
      prompt += u.promptTokens
      completion += u.completionTokens
      counted++
      if (u.basis === "final-call") finalCallOnly++
    } else {
      usageMissing++
    }
  }
  return {
    completed,
    failed,
    promptTokens: counted > 0 ? prompt : null,
    completionTokens: counted > 0 ? completion : null,
    elapsedMs,
    usageMissing,
    finalCallOnly,
  }
}

/**
 * Prompt-token change of `output` against `baseline`, summed only over the
 * questions both modes completed with usage, so neither side counts a
 * question the other is missing. `questions` is how many were compared.
 */
export function pairedPromptChange(
  cells: Array<E2ECell>,
  output: ToolOutput,
  baseline: ToolOutput
): { change: number | null; questions: number } {
  const byKey = indexCells(cells)
  let mine = 0
  let theirs = 0
  let questions = 0
  for (const label of new Set(cells.map((c) => c.label))) {
    const own = byKey.get(cellKey(output, label))
    const base = byKey.get(cellKey(baseline, label))
    const ownUsage = own ? usageOf(own) : null
    const baseUsage = base ? usageOf(base) : null
    if (!ownUsage || !baseUsage) continue
    mine += ownUsage.promptTokens
    theirs += baseUsage.promptTokens
    questions++
  }
  return {
    change: questions > 0 ? relativeChange(mine, theirs) : null,
    questions,
  }
}
