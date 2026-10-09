import { describe, expect, it } from "vitest"

import { contextTotal, fitBreakdown } from "../agent-types"

import type { Breakdown } from "../agent-types"

// cl100k estimates for a turn with one search, as the agent counts them.
const estimate: Breakdown = {
  tool_definitions: 1646,
  system_prompt: 923,
  conversation_history: 253,
  user_message: 6,
  tool_call: 56,
  tool_result: 596,
  final_response: 22,
}

describe("fitBreakdown", () => {
  it("makes the segments add up to LM Studio's exact count", () => {
    const { breakdown } = fitBreakdown(estimate, {
      promptTokens: 3870,
      completionTokens: 79,
      totalTokens: 3949,
      reasoningTokens: 57,
    })
    expect(contextTotal(breakdown)).toBe(3870 + 79)
    // The reply is LM Studio's own count, reasoning included.
    expect(breakdown.final_response).toBe(79)
  })

  it("keeps each segment's share of the prompt", () => {
    const { breakdown, ratio } = fitBreakdown(estimate, {
      promptTokens: 3870,
      completionTokens: 79,
      totalTokens: 3949,
    })
    expect(ratio).toBeCloseTo(3870 / 3480)
    // Rounding moves a segment by one token at most.
    expect(Math.abs(breakdown.tool_definitions - 1646 * ratio)).toBeLessThan(1)
    expect(Math.abs(breakdown.tool_result - 596 * ratio)).toBeLessThan(1)
  })

  it("leaves an empty estimate alone apart from the reply", () => {
    const empty: Breakdown = {
      tool_definitions: 0,
      system_prompt: 0,
      conversation_history: 0,
      user_message: 0,
      tool_call: 0,
      tool_result: 0,
      final_response: 0,
    }
    expect(
      fitBreakdown(empty, {
        promptTokens: 0,
        completionTokens: 12,
        totalTokens: 12,
      })
    ).toEqual({ breakdown: { ...empty, final_response: 12 }, ratio: 1 })
  })
})
