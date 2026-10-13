import { describe, expect, it } from "vitest"
import { render } from "@testing-library/react"

import { Markdown } from "../markdown"

// The chat bubble and the benchmark inspector both render model output
// through this component. These tests pin the shadcn/typeset contract:
// the wrapper carries `typeset` plus a preset, wide tables get the
// documented scroll wrapper, and fenced code opts out of typeset so Shiki
// owns its styling.

const SAMPLE = `Here are the **top options**:

| Airline | Price |
|---|---|
| Delta | $189 |

- Cheapest: [Delta](https://example.com)

\`\`\`json
{"price": 189}
\`\`\`

> Prices change often.`

describe("Markdown", () => {
  it("wraps output in typeset with the chat preset by default", () => {
    const { container } = render(<Markdown>{"Hello **there**"}</Markdown>)
    const root = container.firstElementChild
    expect(root?.classList.contains("typeset")).toBe(true)
    expect(root?.classList.contains("typeset-chat")).toBe(true)
    expect(root?.querySelector("strong")?.textContent).toBe("there")
  })

  it("accepts another preset", () => {
    const { container } = render(
      <Markdown preset="typeset-compact">{"x"}</Markdown>
    )
    expect(
      container.firstElementChild?.classList.contains("typeset-compact")
    ).toBe(true)
  })

  it("renders GFM tables inside typeset-scroll", () => {
    const { container } = render(<Markdown>{SAMPLE}</Markdown>)
    const table = container.querySelector("table")
    expect(table).not.toBeNull()
    expect(table?.parentElement?.classList.contains("typeset-scroll")).toBe(
      true
    )
    expect(container.querySelectorAll("tbody td")).toHaveLength(2)
  })

  it("opens links in a new tab", () => {
    const { container } = render(<Markdown>{SAMPLE}</Markdown>)
    const a = container.querySelector("a")
    expect(a?.getAttribute("target")).toBe("_blank")
    expect(a?.getAttribute("rel")).toContain("noopener")
  })

  // Model output can quote search results, so an image must not make the
  // browser fetch a remote URL on its own.
  it("renders images as links instead of loading them", () => {
    const { container } = render(
      <Markdown>{"![Price chart](https://example.com/chart.png)"}</Markdown>
    )
    expect(container.querySelector("img")).toBeNull()
    const a = container.querySelector("a")
    expect(a?.getAttribute("href")).toBe("https://example.com/chart.png")
    expect(a?.textContent).toBe("Price chart")
    expect(a?.getAttribute("target")).toBe("_blank")
    expect(a?.getAttribute("rel")).toContain("noopener")
  })

  it("labels an image without alt text with its URL", () => {
    const { container } = render(
      <Markdown>{"![](https://example.com/x.png)"}</Markdown>
    )
    expect(container.querySelector("a")?.textContent).toBe(
      "https://example.com/x.png"
    )
  })

  it("does not nest a link inside a linked image", () => {
    const { container } = render(
      <Markdown>
        {
          "[![Hotel photo](https://example.com/h.jpg)](https://example.com/hotel)"
        }
      </Markdown>
    )
    expect(container.querySelector("img")).toBeNull()
    expect(container.querySelectorAll("a")).toHaveLength(1)
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/hotel"
    )
    expect(container.querySelector("a")?.textContent).toBe("Hotel photo")
  })

  it("keeps fenced code out of typeset styling", () => {
    const { container } = render(<Markdown>{SAMPLE}</Markdown>)
    const block = container.querySelector(".not-typeset")
    expect(block).not.toBeNull()
    expect(block?.textContent).toContain('{"price": 189}')
    // No stray <pre> outside the code block (the `pre` override unwraps it).
    expect(container.querySelectorAll(":scope > .typeset > pre")).toHaveLength(
      0
    )
  })
})
