import { describe, expect, it } from "vitest"

import { pickDefaultModel } from "../models"

import type { ModelInfo } from "@/lib/agent-types"

const model = (id: string, toolUseTrained = true): ModelInfo => ({
  id,
  displayName: id,
  arch: null,
  params: null,
  maxContextLength: 32768,
  currentContextLength: null,
  toolUseTrained,
  format: null,
  recommendedContextLength: 32768,
})

describe("pickDefaultModel", () => {
  it("prefers Qwen 3.8 27B over other Qwen models", () => {
    const models = [model("qwen/qwen3.5-9b"), model("qwen/qwen3.8-27b")]
    expect(pickDefaultModel(models)?.id).toBe("qwen/qwen3.8-27b")
  })

  it("falls back to any Qwen, then a tool-trained model, then the first", () => {
    expect(
      pickDefaultModel([
        model("google/gemma-4-12b-qat"),
        model("qwen/qwen3.5-9b"),
      ])?.id
    ).toBe("qwen/qwen3.5-9b")
    expect(
      pickDefaultModel([
        model("base/model", false),
        model("google/gemma-4-12b-qat"),
      ])?.id
    ).toBe("google/gemma-4-12b-qat")
    expect(pickDefaultModel([model("base/model", false)])?.id).toBe(
      "base/model"
    )
  })

  it("returns null for an empty list", () => {
    expect(pickDefaultModel([])).toBeNull()
  })
})
