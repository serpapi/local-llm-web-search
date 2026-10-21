import { describe, expect, it } from "vitest"

import {
  AI_OVERVIEW_RESTRICTORS,
  MARKDOWN_RESTRICTORS,
  RESTRICTORS,
} from "../restrictors"

describe("Markdown search restrictor", () => {
  it("leads with five organic results, then the answer box and AI Overview", () => {
    expect(MARKDOWN_RESTRICTORS.google_search).toMatch(
      /^organic_results\[0:5\]\.\{title,link,snippet,date\}/
    )
    const order = ["organic_results", "answer_box", "ai_overview"].map((p) =>
      MARKDOWN_RESTRICTORS.google_search.indexOf(p)
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
})

describe("Search restrictors and the AI Overview", () => {
  const modes = [
    ["json", RESTRICTORS.google_search],
    ["markdown", MARKDOWN_RESTRICTORS.google_search],
  ] as const

  it("keep a deferred overview's page token and ask the follow-up for the same fields", () => {
    for (const [mode, search] of modes) {
      const followUp = AI_OVERVIEW_RESTRICTORS[mode]
      expect(followUp.startsWith("ai_overview.{")).toBe(true)
      expect(search).toContain(
        followUp.replace("ai_overview.{", "ai_overview.{page_token,")
      )
    }
  })

  it("drop related questions, which Google now sends without answers", () => {
    // 2026-10-21: none of 40 related questions across 10 searches had a
    // snippet, and "Who is the 2nd CEO of Google?" reached the model on a
    // question about SerpApi's CEO.
    for (const [, search] of modes) {
      expect(search).not.toContain("related_questions")
    }
  })
})
