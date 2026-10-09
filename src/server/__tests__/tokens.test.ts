import { describe, expect, it } from "vitest"

import { countTokens } from "../tokens.server"

describe("countTokens", () => {
  it("counts special-token text as plain text instead of throwing", () => {
    // A question about tokenizers, or a search result quoting one.
    expect(countTokens("What does <|endoftext|> mean?")).toBeGreaterThan(5)
  })
})
