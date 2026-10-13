import { describe, expect, it } from "vitest"

import { MARKDOWN_RESTRICTORS } from "../restrictors"

describe("Markdown search restrictor", () => {
  it("leads with five organic results and keeps related questions last", () => {
    expect(MARKDOWN_RESTRICTORS.google_search).toMatch(
      /^organic_results\[0:5\]\.\{title,link,snippet,date\}/
    )
    const order = ["organic_results", "answer_box", "related_questions"].map(
      (p) => MARKDOWN_RESTRICTORS.google_search.indexOf(p)
    )
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })
})
