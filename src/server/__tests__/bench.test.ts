import { describe, expect, it } from "vitest"

import {
  benchRunSchema,
  payloadMeasurementSchema,
  upgradeLegacyRun,
} from "../bench"

// The shape the first benchmark page saved: payload rows without args,
// end-to-end cells keyed "mode|label" with whatever it happened to record.
const legacy = {
  savedAt: "2026-09-14T22:02:32.000Z",
  model: "qwen/qwen3.8-27b",
  payload: [
    {
      label: "Search",
      tool: "google_search",
      output: "json",
      restrictor: null,
      tokens: 120,
      bytes: 480,
      serpApiMs: 900,
      error: null,
    },
  ],
  e2e: {
    "json|Search": {
      status: "done",
      answer: "Tim Cook.",
      toolResultTokens: 120,
      promptTokens: 900,
      completionTokens: 40,
      toolCalls: ["google_search"],
      elapsedMs: 42000,
      phases: { firstInferenceMs: 25000, secondInferenceMs: 17000 },
    },
    "markdown|Search": { status: "error", error: "boom" },
    "markdown|Finance": { status: "running" },
    "bogus|Search": { status: "done" },
  },
}

describe("upgradeLegacyRun", () => {
  const run = upgradeLegacyRun(legacy, "2026-09-14T22-02-32-run.json")

  it("parses as a current run", () => {
    expect(run).not.toBeNull()
    expect(benchRunSchema.safeParse(run).success).toBe(true)
    expect(run?.name).toBe("run")
  })

  it("marks what v1 never recorded as unknown instead of zero", () => {
    expect(run?.model?.requestedContext).toBeNull()
    const done = run?.e2e.find(
      (c) => c.status === "completed" && c.output === "json"
    )
    expect(done).toMatchObject({
      elapsedMs: 42000,
      toolCalls: [{ name: "google_search", tokens: null, serpApiMs: null }],
      phases: {
        firstInferenceMs: 25000,
        toolExecutionMs: null,
        secondInferenceMs: 17000,
      },
    })
    const failed = run?.e2e.find((c) => c.status === "failed")
    expect(failed).toMatchObject({ output: "markdown", elapsedMs: null })
  })

  it("skips cells that never finished or name an unknown mode", () => {
    expect(run?.e2e).toHaveLength(2)
  })
})

describe("payloadMeasurementSchema", () => {
  const base = {
    label: "Search",
    tool: "google_search",
    args: {},
    output: "json",
    restrictor: null,
    serpApiMs: 900,
  }

  it("accepts a failed measurement with no size", () => {
    expect(
      payloadMeasurementSchema.safeParse({
        ...base,
        tokens: null,
        bytes: null,
        error: "SerpApi timed out",
      }).success
    ).toBe(true)
  })

  it("requires a size on a successful measurement", () => {
    expect(
      payloadMeasurementSchema.safeParse({
        ...base,
        tokens: null,
        bytes: null,
        error: null,
      }).success
    ).toBe(false)
    expect(
      payloadMeasurementSchema.safeParse({
        ...base,
        tokens: 120,
        bytes: 480,
        error: null,
      }).success
    ).toBe(true)
  })
})
