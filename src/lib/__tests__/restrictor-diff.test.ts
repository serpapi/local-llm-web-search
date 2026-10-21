import { describe, expect, it } from "vitest"
import {
  keptJsonLines,
  keptMarkdownRanges,
  markKeptMarkdown,
} from "../restrictor-diff"
import type { BlockNode, InlineNode } from "@tanstack/markdown"

describe("keptJsonLines", () => {
  const full = {
    search_metadata: { id: "x" },
    local_results: [
      { title: "Franklin", rating: 4.7, place_id: "a" },
      { title: "Terry Black's", rating: 4.7, place_id: "b" },
    ],
    empty: [],
  }
  const sent = { local_results: [{ title: "Franklin", rating: 4.7 }] }

  it("prints exactly what JSON.stringify prints", () => {
    expect(
      keptJsonLines(full, sent)
        .map((l) => l.text)
        .join("\n")
    ).toBe(JSON.stringify(full, null, 2))
  })

  it("marks only the keys and items the restrictor kept", () => {
    const kept = keptJsonLines(full, sent)
      .filter((l) => l.kept)
      .map((l) => l.text.trim())
    expect(kept).toEqual([
      '"local_results": [',
      "{",
      '"title": "Franklin",',
      '"rating": 4.7,',
      "},",
      "],",
    ])
  })
})

function textOf(nodes: Array<InlineNode>): string {
  return nodes
    .map((c) =>
      c.type === "text" ? c.value : "children" in c ? textOf(c.children) : ""
    )
    .join("")
}

// The marked inline texts of a parsed document, in order.
function markedTexts(blocks: Array<BlockNode>): Array<string> {
  const out: Array<string> = []
  const fromInlines = (nodes: Array<InlineNode>) => {
    for (const n of nodes) {
      if (n.type === "inlineComponent" && n.tagName === "mark") {
        out.push(textOf(n.children))
      }
    }
  }
  for (const b of blocks) {
    if (b.type === "heading" || b.type === "paragraph") fromInlines(b.children)
    if (b.type === "list") {
      for (const item of b.items) {
        for (const c of item.children) {
          if (c.type === "paragraph") fromInlines(c.children)
        }
      }
    }
    if (b.type === "table") {
      for (const cell of b.header) fromInlines(cell.children)
      for (const row of b.rows)
        for (const cell of row) fromInlines(cell.children)
    }
  }
  return out
}

describe("markKeptMarkdown", () => {
  const full = `## Graph

| Price | Currency |
| --- | --- |
| 220.79 | USD |

## Summary

- Title: NVIDIA Corp
- Currency: USD
- Extracted price: 222.025

## Local Results

| Title | Rating | Place id |
| --- | --- | --- |
| Franklin | 4.7 | a |
| Terry Black's | 4.7 | b |
`
  const sent = `## Summary

- Title: NVIDIA Corp
- Currency: USD

## Local Results

| Title | Rating |
| --- | --- |
| Franklin | 4.7 |
`

  it("marks kept sections, list items and table cells only", () => {
    const doc = markKeptMarkdown(full, sent, "kept")
    expect(markedTexts(doc.children)).toEqual([
      "Summary",
      "Title: NVIDIA Corp",
      "Currency: USD",
      "Local Results",
      "Title",
      "Rating",
      "Franklin",
      "4.7",
    ])
  })
})

describe("markKeptMarkdown edge cases", () => {
  it("compares table cells by column, not by value", () => {
    const doc = markKeptMarkdown(
      "## Places\n\n| Title | Rating | Reviews |\n| --- | --- | --- |\n| Cafe | 5 | 5 |\n",
      "## Places\n\n| Title | Rating |\n| --- | --- |\n| Cafe | 5 |\n",
      "kept"
    )
    expect(markedTexts(doc.children)).toEqual([
      "Places",
      "Title",
      "Rating",
      "Cafe",
      "5",
    ])
    const table = doc.children.find((b) => b.type === "table")
    const reviews = table?.type === "table" ? table.rows[0][2] : undefined
    expect(reviews?.children[0]?.type).toBe("text")
  })

  it("marks a repeated text only as often as it was kept", () => {
    const doc = markKeptMarkdown(
      "## News\n\n- Source: Reuters\n- Source: Reuters\n",
      "## News\n\n- Source: Reuters\n",
      "kept"
    )
    expect(markedTexts(doc.children)).toEqual(["News", "Source: Reuters"])
  })

  it("keeps the first stories of each cluster, not of the section", () => {
    // news_results[].stories[0:2]: each cluster keeps its own first two.
    const full = `## News Results

- Title: Cluster A
  - Stories:
    - Source: AP
    - Source: CNN
    - Source: Reuters
- Title: Cluster B
  - Stories:
    - Source: Reuters
`
    const sent = `## News Results

- Title: Cluster A
  - Stories:
    - Source: AP
    - Source: CNN
- Title: Cluster B
  - Stories:
    - Source: Reuters
`
    const doc = markKeptMarkdown(full, sent, "kept")
    const list = doc.children.find((b) => b.type === "list")
    const sources = (clusterIndex: number) => {
      if (list?.type !== "list") return []
      const stories = list.items[clusterIndex].children.find(
        (b) => b.type === "list"
      )
      const inner =
        stories?.type === "list"
          ? stories.items[0].children.find((b) => b.type === "list")
          : undefined
      if (inner?.type !== "list") return []
      return inner.items.map((item) => {
        const p = item.children[0]
        return (
          p.type === "paragraph" && p.children[0]?.type === "inlineComponent"
        )
      })
    }
    expect(sources(0)).toEqual([true, true, false])
    expect(sources(1)).toEqual([true])
  })

  it("scopes repeated sub-headings to the result above them", () => {
    const full =
      "## News Results\n\n### Cluster A\n\n#### Stories\n\n- Source: AP\n- Source: Reuters\n\n### Cluster B\n\n#### Stories\n\n- Source: Reuters\n"
    const sent =
      "## News Results\n\n### Cluster A\n\n#### Stories\n\n- Source: AP\n\n### Cluster B\n\n#### Stories\n\n- Source: Reuters\n"
    expect(markedTexts(markKeptMarkdown(full, sent, "kept").children)).toEqual([
      "News Results",
      "Cluster A",
      "Stories",
      "Source: AP",
      "Cluster B",
      "Stories",
      "Source: Reuters",
    ])
  })

  it("finds a kept list after a dropped one under the same heading", () => {
    const full =
      "## Place\n\n**Extensions**\n\n- Wheelchair access\n\n**Hours**\n\n- Monday: 11 AM\n"
    const sent = "## Place\n\n**Hours**\n\n- Monday: 11 AM\n"
    expect(markedTexts(markKeptMarkdown(full, sent, "kept").children)).toEqual([
      "Place",
      "Hours",
      "Monday: 11 AM",
    ])
  })

  it("matches a kept table to its own label, not an earlier dropped one", () => {
    const table = "| Day | Open |\n| --- | --- |\n| Monday | 11 AM |\n"
    const full = `## Place\n\n**Popular times**\n\n${table}\n**Hours**\n\n${table}`
    const sent = `## Place\n\n**Hours**\n\n${table}`
    const doc = markKeptMarkdown(full, sent, "kept")
    const marked = doc.children.flatMap((t) =>
      t.type === "table"
        ? [
            [...t.header, ...t.rows[0]].filter(
              (c) => c.children[0]?.type === "inlineComponent"
            ).length,
          ]
        : []
    )
    expect(marked).toEqual([0, 4])
  })

  it("ignores a dropped value paragraph before an unlabelled list", () => {
    const full =
      "## Place\n\nRating: 4.7\n\n- Monday: 11 AM\n- Tuesday: 11 AM\n"
    const sent = "## Place\n\n- Monday: 11 AM\n- Tuesday: 11 AM\n"
    expect(markedTexts(markKeptMarkdown(full, sent, "kept").children)).toEqual([
      "Place",
      "Monday: 11 AM",
      "Tuesday: 11 AM",
    ])
  })

  it("finds a kept field nested in an item after a dropped one", () => {
    const full =
      "## Places\n\n- Name: Cafe\n\n  **Extensions**\n\n  - Wheelchair access\n\n  **Hours**\n\n  - Monday: 11 AM\n"
    const sent =
      "## Places\n\n- Name: Cafe\n\n  **Hours**\n\n  - Monday: 11 AM\n"
    const doc = markKeptMarkdown(full, sent, "kept")
    const all: Array<string> = []
    const collect = (blocks: Array<BlockNode>) => {
      for (const b of blocks) {
        if (b.type === "paragraph") {
          for (const n of b.children) {
            if (n.type === "inlineComponent") all.push(textOf(n.children))
          }
        }
        if (b.type === "list")
          for (const item of b.items) collect(item.children)
      }
    }
    collect(doc.children)
    expect(all).toEqual(["Name: Cafe", "Hours", "Monday: 11 AM"])
  })

  it("still marks a kept field the restricted output lists in another order", () => {
    const full = "## Summary\n\n- Title: NVIDIA\n- Stock: NVDA\n- Price: 222\n"
    const sent = "## Summary\n\n- Title: NVIDIA\n- Price: 222\n- Stock: NVDA\n"
    expect(markedTexts(markKeptMarkdown(full, sent, "kept").children)).toEqual([
      "Summary",
      "Title: NVIDIA",
      "Stock: NVDA",
      "Price: 222",
    ])
  })

  it("matches sections by name when the restricted output reorders them", () => {
    // The restrictor lists Organic Results first; the full page has Top
    // Stories first, and its story also appears as a dropped organic row.
    const head = "| Title | Link |\n| --- | --- |\n"
    const full = `## Top Stories\n\n${head}| Story | s |\n\n## Organic Results\n\n${head}| First | f |\n| Story | s |\n`
    const sent = `## Organic Results\n\n${head}| First | f |\n\n## Top Stories\n\n${head}| Story | s |\n`
    const doc = markKeptMarkdown(full, sent, "kept")
    const marked = doc.children.flatMap((b) =>
      b.type === "table"
        ? [b.rows.map((row) => row[0].children[0]?.type === "inlineComponent")]
        : []
    )
    expect(marked).toEqual([[true], [true, false]])
  })
})

describe("keptMarkdownRanges", () => {
  const texts = (full: string, sent: string) =>
    keptMarkdownRanges(full, sent).map(([a, b]) => full.slice(a, b))

  it("marks the kept columns of a table row in the source", () => {
    const full =
      "## Places\n\n| Title | Rating | Reviews |\n| --- | --- | --- |\n| Cafe | 5 | 5 |\n| Bar | 4 | 9 |\n"
    const sent =
      "## Places\n\n| Title | Rating |\n| --- | --- |\n| Cafe | 5 |\n"
    const ranges = keptMarkdownRanges(full, sent)
    expect(texts(full, sent)).toEqual([
      "## Places",
      "Title",
      "Rating",
      "Cafe",
      "5",
    ])
    // The 5 under Rating, not the one under Reviews.
    const row = full.indexOf("| Cafe")
    expect(ranges.at(-1)?.[0]).toBe(full.indexOf("5", row))
  })

  it("keeps escaped pipes inside a cell", () => {
    const full =
      "## Organic Results\n\n| Title | Link |\n| --- | --- |\n| Author \\| Speaker | a |\n"
    expect(texts(full, full)).toContain("Author \\| Speaker")
  })

  it("marks lines of a section the restricted output moved", () => {
    const full =
      "## Top Stories\n\n- Story\n\n## Organic Results\n\n- First\n- Story\n"
    const sent = "## Organic Results\n\n- First\n\n## Top Stories\n\n- Story\n"
    const ranges = keptMarkdownRanges(full, sent).map(([a]) => a)
    expect(ranges).toContain(full.indexOf("- Story"))
    expect(ranges).not.toContain(full.lastIndexOf("- Story"))
  })

  it("doesn't let a nested field stand in for a top-level one", () => {
    const full =
      "## Summary\n\n- Market:\n  - Price: USD218.29\n- Price: USD218.29\n"
    const sent = "## Summary\n\n- Price: USD218.29\n"
    const ranges = keptMarkdownRanges(full, sent).map(([a]) => a)
    expect(ranges).toContain(full.lastIndexOf("- Price"))
    expect(ranges).not.toContain(full.indexOf("- Price"))
  })

  it("reads tables written without outer pipes", () => {
    const full =
      "## Places\n\nTitle | Rating | Reviews\n--- | :---: | ---\nCafe | 5 | 5\n"
    const sent = "## Places\n\nTitle | Rating\n--- | ---\nCafe | 5\n"
    expect(texts(full, sent)).toEqual([
      "## Places",
      "Title",
      "Rating",
      "Cafe",
      "5",
    ])
    const row = full.indexOf("Cafe")
    expect(keptMarkdownRanges(full, sent).at(-1)?.[0]).toBe(
      full.indexOf("5", row)
    )
  })

  it("handles Windows line endings", () => {
    const full =
      "## Places\r\n\r\n| Title | Rating |\r\n| --- | --- |\r\n| Cafe | 5 |\r\n"
    expect(texts(full, full)).toEqual([
      "## Places",
      "Title",
      "Rating",
      "Cafe",
      "5",
    ])
  })

  it("ends a table at a list item with no blank line before it", () => {
    const full =
      "## Place\n\n| Day | Open |\n| --- | --- |\n| Monday | 11 AM |\n- Tags: bbq | brisket\n"
    const sent = "## Place\n\n- Tags: bbq | brisket\n"
    expect(texts(full, sent)).toEqual(["## Place", "- Tags: bbq | brisket"])
  })
})
