import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render } from "@testing-library/react"

import { ResponseView } from "@/components/response-view"

afterEach(cleanup)

describe("ResponseView", () => {
  it("shows markup inside a response as text, never as HTML", () => {
    const payload = '<img src="x" onerror="alert(1)">'
    const json = render(<ResponseView value={{ snippet: payload }} />)
    expect(json.container.querySelector("img")).toBeNull()
    expect(json.container.textContent).toContain('<img src=\\"x\\"')
    cleanup()
    for (const view of ["source", "preview"] as const) {
      const markdown = render(
        <ResponseView value={`## Title\n\n${payload}`} view={view} />
      )
      expect(markdown.container.querySelector("img")).toBeNull()
      cleanup()
    }
  })

  it("shows Markdown images as links instead of loading them", () => {
    const { container } = render(
      <ResponseView
        value="![pixel](https://untrusted.example/pixel.png)"
        view="preview"
      />
    )
    expect(container.querySelector("img")).toBeNull()
    const link = container.querySelector("a")
    expect(link?.getAttribute("href")).toBe(
      "https://untrusted.example/pixel.png"
    )
    expect(link?.getAttribute("rel")).toBe("noreferrer noopener")
  })

  it("marks the kept lines of a JSON response", () => {
    const { container } = render(
      <ResponseView
        value={{ a: 1, b: { c: "x" } }}
        keptIn={{ b: { c: "x" } }}
      />
    )
    expect(
      [...container.querySelectorAll("[data-kept]")].map((l) =>
        l.textContent.trim()
      )
    ).toEqual(['"b": {', '"c": "x"', "}"])
  })
})
