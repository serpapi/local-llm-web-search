import { describe, expect, it } from "vitest"

import {
  cellKey,
  e2eSummary,
  exceedsContext,
  failureLabel,
  formatChange,
  formatKb,
  formatSeconds,
  formatTokens,
  hitCompletionCap,
  interleaveCells,
  isActiveJob,
  measuredTokens,
  pairedPromptChange,
  payloadTotals,
  queuedRunName,
  relativeChange,
  runFileName,
  usageOf,
} from "../bench"

import type { BenchJob, E2ECell, PayloadMeasurement } from "@/lib/bench-schemas"

const completed = (over: Partial<E2ECell> = {}): E2ECell =>
  ({
    status: "completed",
    label: "Search",
    question: "q",
    output: "json",
    answer: "a",
    toolCalls: [],
    toolResultTokens: 100,
    finalUsage: { promptTokens: 900, completionTokens: 50, totalTokens: 950 },
    totalUsage: {
      promptTokens: 1500,
      completionTokens: 80,
      totalTokens: 1580,
      completions: 2,
    },
    elapsedMs: 4000,
    phases: { firstInferenceMs: 1, toolExecutionMs: 1, secondInferenceMs: 1 },
    loadedContext: null,
    ...over,
  }) as E2ECell

describe("relativeChange / formatChange", () => {
  it("returns null when either side is missing or the baseline is zero", () => {
    expect(relativeChange(undefined, 10)).toBeNull()
    expect(relativeChange(10, undefined)).toBeNull()
    expect(relativeChange(10, 0)).toBeNull()
    expect(formatChange(null)).toBe("–")
  })

  it("formats small changes as signed percentages and large ones as multipliers", () => {
    expect(formatChange(relativeChange(80, 100))).toBe("-20%")
    expect(formatChange(relativeChange(124, 100))).toBe("+24%")
    expect(formatChange(relativeChange(840, 100))).toBe("8.4×")
    expect(formatChange(relativeChange(100, 100))).toBe("0%")
  })
})

describe("formatting", () => {
  it("renders missing values as a dash, never zero", () => {
    expect(formatTokens(null)).toBe("–")
    expect(formatTokens(undefined)).toBe("–")
    expect(formatSeconds(null)).toBe("–")
  })

  it("keeps one decimal below 100 s and rounds above", () => {
    expect(formatSeconds(4400)).toBe("4.4 s")
    expect(formatSeconds(123400)).toBe("123 s")
  })
})

const payloadRow = (
  output: PayloadMeasurement["output"],
  tokens: number
): PayloadMeasurement => ({
  label: "x",
  tool: "google_search",
  args: {},
  output,
  restrictor: null,
  tokens,
  bytes: 0,
  serpApiMs: 0,
  error: null,
})

const failedRow = (
  output: PayloadMeasurement["output"]
): PayloadMeasurement => ({
  label: "x",
  tool: "google_search",
  args: {},
  output,
  restrictor: null,
  tokens: null,
  bytes: null,
  serpApiMs: 0,
  error: "boom",
})

describe("payloadTotals", () => {
  it("sums successful rows per mode and counts errors separately", () => {
    const row = payloadRow
    const totals = payloadTotals([
      row("json-full", 4000),
      row("json", 100),
      row("json", 200),
      failedRow("markdown"),
      row("markdown-full", 5000),
    ])
    expect(totals.json).toEqual({ tokens: 300, count: 2, errors: 0 })
    expect(totals.markdown).toEqual({ tokens: 0, count: 0, errors: 1 })
    expect(totals["markdown-full"].tokens).toBe(5000)
    expect(totals["json-full"]).toEqual({ tokens: 4000, count: 1, errors: 0 })
  })
})

describe("measuredTokens / formatKb", () => {
  it("only reads a size from a measurement that succeeded", () => {
    expect(measuredTokens(payloadRow("json", 120))).toBe(120)
    expect(measuredTokens(failedRow("json"))).toBeUndefined()
    expect(measuredTokens(undefined)).toBeUndefined()
  })

  it("renders an unknown size as a dash", () => {
    expect(formatKb(2048)).toBe("2.0 KB")
    expect(formatKb(null)).toBe("–")
  })
})

describe("usageOf / e2eSummary", () => {
  it("prefers the turn total and falls back to the final call, labelled", () => {
    expect(usageOf(completed())).toMatchObject({
      promptTokens: 1500,
      basis: "turn",
    })
    expect(usageOf(completed({ totalUsage: null }))).toMatchObject({
      promptTokens: 900,
      basis: "final-call",
    })
    expect(
      usageOf(completed({ totalUsage: null, finalUsage: null }))
    ).toBeNull()
    expect(
      usageOf({
        status: "failed",
        label: "Search",
        question: "q",
        output: "json",
        error: "x",
        elapsedMs: 1,
      })
    ).toBeNull()
  })

  it("excludes cells without usage from totals instead of counting zero", () => {
    const cells: Array<E2ECell> = [
      completed(),
      completed({ label: "News", totalUsage: null, finalUsage: null }),
      completed({ label: "Maps", totalUsage: null }),
      {
        status: "failed",
        label: "Maps",
        question: "q",
        output: "json",
        error: "timeout",
        elapsedMs: 60000,
      },
      completed({ label: "Search", output: "markdown" }),
    ]
    const s = e2eSummary(cells, "json")
    expect(s.completed).toBe(3)
    expect(s.failed).toBe(1)
    expect(s.promptTokens).toBe(1500 + 900)
    expect(s.usageMissing).toBe(1)
    expect(s.finalCallOnly).toBe(1)
    expect(s.elapsedMs).toBe(4000 * 3 + 60000)
  })

  it("leaves unrecorded times out of the total instead of adding zero", () => {
    const s = e2eSummary(
      [
        completed(),
        {
          status: "failed",
          label: "Maps",
          question: "q",
          output: "json",
          error: "boom",
          elapsedMs: null,
        },
      ],
      "json"
    )
    expect(s.elapsedMs).toBe(4000)
  })

  it("returns null totals when nothing in the mode reported usage", () => {
    const s = e2eSummary(
      [completed({ totalUsage: null, finalUsage: null })],
      "json"
    )
    expect(s.promptTokens).toBeNull()
    expect(s.completionTokens).toBeNull()
  })

  it("builds stable cell keys", () => {
    expect(cellKey("markdown-full", "Flights")).toBe("markdown-full|Flights")
  })
})

describe("interleaveCells", () => {
  it("runs every mode for one question before the next question", () => {
    expect(
      interleaveCells(["Search", "Maps"], ["json", "markdown"]).map(
        ({ mode, q }) => `${q}:${mode}`
      )
    ).toEqual(["Search:json", "Search:markdown", "Maps:json", "Maps:markdown"])
  })
})

describe("exceedsContext", () => {
  it("flags a completed cell whose final prompt outgrew the loaded context", () => {
    const final = {
      promptTokens: 62657,
      completionTokens: 341,
      totalTokens: 62998,
    }
    expect(
      exceedsContext(completed({ finalUsage: final, loadedContext: 32768 }))
    ).toBe(true)
  })

  it("ignores cells that fit, have no context, or failed", () => {
    expect(exceedsContext(completed({ loadedContext: 32768 }))).toBe(false)
    expect(exceedsContext(completed({ loadedContext: null }))).toBe(false)
    expect(
      exceedsContext({
        status: "failed",
        label: "Search",
        question: "q",
        output: "json",
        error: "e",
        elapsedMs: 1,
      })
    ).toBe(false)
  })
})

describe("failureLabel", () => {
  it("turns LM Studio's context error into one sentence", () => {
    expect(
      failureLabel(
        'LM Studio second completion failed: 400 "Engine protocol predict request returned 400: {\\"error\\":{\\"code\\":400,\\"message\\":\\"request (63382 tokens) exceeds the available context size (32768 tokens), try increasing it\\"}}"'
      )
    ).toBe("The prompt (63,382 tokens) is over the 32,768-token context.")
  })

  it("names unparseable model output and leaves other errors alone", () => {
    expect(
      failureLabel(
        "LM Studio second completion failed: The model produced output that does not match the expected peg-native format"
      )
    ).toBe("LM Studio could not parse the model's output.")
    expect(failureLabel("The model returned an empty reply.")).toBe(
      "The model returned an empty reply."
    )
  })
})

describe("hitCompletionCap", () => {
  it("trusts the recorded finish reason", () => {
    expect(hitCompletionCap(completed({ cutOff: true }))).toBe(true)
    expect(hitCompletionCap(completed({ cutOff: false }))).toBe(false)
  })

  it("falls back to the old 1,500-token cap for runs saved before the field", () => {
    const final = {
      promptTokens: 20465,
      completionTokens: 1499,
      totalTokens: 21964,
    }
    expect(hitCompletionCap(completed({ finalUsage: final }))).toBe(true)
    expect(hitCompletionCap(completed())).toBe(false)
    expect(hitCompletionCap(completed({ finalUsage: null }))).toBe(false)
  })
})

describe("pairedPromptChange", () => {
  const usage = (promptTokens: number) => ({
    totalUsage: {
      promptTokens,
      completionTokens: 10,
      totalTokens: promptTokens + 10,
      completions: 2,
    },
  })
  const failed = (label: string, output: E2ECell["output"]): E2ECell => ({
    status: "failed",
    label,
    question: "q",
    output,
    error: "boom",
    elapsedMs: 1,
  })

  it("only compares questions both modes completed with usage", () => {
    const cells: Array<E2ECell> = [
      completed({ label: "Search", output: "json", ...usage(1000) }),
      completed({ label: "Search", output: "markdown", ...usage(800) }),
      // Markdown alone finished Maps: leaving it in would inflate Markdown.
      failed("Maps", "json"),
      completed({ label: "Maps", output: "markdown", ...usage(50000) }),
      // JSON alone finished News: leaving it in would inflate JSON.
      completed({ label: "News", output: "json", ...usage(9000) }),
      failed("News", "markdown"),
      // No usage on one side.
      completed({
        label: "Hotels",
        output: "json",
        totalUsage: null,
        finalUsage: null,
      }),
      completed({ label: "Hotels", output: "markdown", ...usage(700) }),
    ]
    expect(pairedPromptChange(cells, "markdown", "json")).toEqual({
      change: -0.2,
      questions: 1,
    })
  })

  it("returns null when no question finished in both modes", () => {
    expect(
      pairedPromptChange(
        [completed({ output: "markdown" }), failed("Search", "markdown-full")],
        "markdown",
        "markdown-full"
      )
    ).toEqual({ change: null, questions: 0 })
  })
})

describe("runFileName", () => {
  it("prefixes a file-safe start time that sorts by date", () => {
    expect(runFileName("nightly", new Date("2026-10-05T15:24:57.123Z"))).toBe(
      "2026-10-05T15-24-57-nightly.json"
    )
  })
})

describe("isActiveJob", () => {
  it("counts running and stopping as active", () => {
    const job = (status: BenchJob["status"]) => ({ status }) as BenchJob
    expect(isActiveJob(job("running"))).toBe(true)
    expect(isActiveJob(job("stopping"))).toBe(true)
    expect(isActiveJob(job("done"))).toBe(false)
    expect(isActiveJob(job("stopped"))).toBe(false)
    expect(isActiveJob(null)).toBe(false)
  })
})

describe("queuedRunName", () => {
  it("names each queued run after its model, after the run name if any", () => {
    expect(queuedRunName("", "qwen/qwen3.8-27b")).toBe("qwen3-8-27b")
    expect(queuedRunName("cap-4096", "google/gemma-4-12b-qat")).toBe(
      "cap-4096-gemma-4-12b-qat"
    )
  })
})
