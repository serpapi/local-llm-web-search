import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { ContextWindow } from "@/components/context-window"

afterEach(cleanup)

const breakdown = {
  tool_definitions: 2000,
  system_prompt: 1000,
  conversation_history: 0,
  user_message: 10,
  tool_call: 40,
  tool_result: 800,
  final_response: 80,
}

function view(onInspect = vi.fn()) {
  render(
    <ContextWindow
      breakdown={breakdown}
      fitted
      exactUsage={null}
      modelContext={{ loaded: 32768, max: 262144 }}
      searches={[
        { label: "Search · paris", tokens: 500 },
        { label: "Search · rome", tokens: 300 },
      ]}
      onInspect={onInspect}
    />
  )
  return onInspect
}

describe("ContextWindow", () => {
  it("lists only the parts that filled the context", () => {
    view()
    expect(screen.queryByText("History")).toBeNull()
    expect(screen.getByText("Tool definitions")).toBeTruthy()
  })

  it("shows a part's tokens while it is hovered", () => {
    view()
    fireEvent.mouseEnter(screen.getByText("System prompt").closest("li")!)
    expect(screen.getByText("1,000")).toBeTruthy()
  })

  it("opens a search from the tool result", () => {
    const onInspect = view()
    const toggle = screen.getByRole("button", { name: /tool result/i })
    expect(toggle.getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole("button", { name: /rome/ }))
    expect(onInspect).toHaveBeenCalledWith(1)
  })

  it("keeps a cell for every part when one part fills the window", () => {
    const { container } = render(
      <ContextWindow
        breakdown={{
          tool_definitions: 32762,
          system_prompt: 1,
          conversation_history: 1,
          user_message: 1,
          tool_call: 1,
          tool_result: 1,
          final_response: 1,
        }}
        fitted
        exactUsage={null}
        modelContext={{ loaded: 32768, max: 262144 }}
        searches={[]}
        onInspect={() => {}}
      />
    )
    const field = container.querySelector("div[aria-hidden='true']")
    const colors = new Set(
      [...(field?.children ?? [])].map(
        (cell) =>
          cell.className.split(" ").find((c) => c.startsWith("bg-")) ?? ""
      )
    )
    // Seven parts, every one with at least one cell.
    expect(colors.size).toBe(7)
  })
})
