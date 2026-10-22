import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import type { ModelInfo, ToolCallInfo } from "@/lib/agent-types"
import { ModelSelector } from "@/components/model-selector"
import { RestrictorDialog } from "@/components/restrictor-dialog"

// The chat composer's model picker and the tool-call dialog, in the states
// where something went wrong.

const searchCall: ToolCallInfo = {
  name: "google_search",
  args: { query: "weather in Paris" },
  restrictor: "organic_results[0:5].{title,link}",
  output: "json",
  response: { organic_results: [] },
  tokens: 120,
  serpApiMs: 800,
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("ModelSelector", () => {
  it("keeps the LM Studio error available when it is unreachable", () => {
    const error =
      "Can't reach LM Studio at http://localhost:1234/api/v1: fetch failed"
    render(
      <ModelSelector
        availableModels={[]}
        selectedModel={null}
        onSelectModel={() => {}}
        modelsError={error}
      />
    )
    expect(screen.getByRole("alert").textContent).toContain(
      "LM Studio unreachable"
    )
    expect(screen.getByTitle(error)).toBeTruthy()
  })
})

const model = (id: string): ModelInfo => ({
  id,
  displayName: id,
  arch: null,
  params: null,
  maxContextLength: 32768,
  currentContextLength: null,
  toolUseTrained: true,
  format: null,
  recommendedContextLength: 32768,
})

describe("ModelSelector with several models", () => {
  const qwen = model("qwen/qwen3.8-27b")
  const gemma = model("google/gemma-4-12b-qat")

  it("shows how many more models are picked", () => {
    render(
      <ModelSelector
        multiple
        availableModels={[qwen, gemma]}
        selectedModels={[qwen, gemma]}
        onSelectModels={() => {}}
        modelsError={null}
      />
    )
    expect(
      screen.getByRole("button", { name: /select models/i }).textContent
    ).toContain("+1")
  })

  it("adds a model and never removes the last one", () => {
    const onSelectModels = vi.fn()
    const { rerender } = render(
      <ModelSelector
        multiple
        availableModels={[qwen, gemma]}
        selectedModels={[qwen]}
        onSelectModels={onSelectModels}
        modelsError={null}
      />
    )
    const trigger = screen.getByRole("button", { name: /select models/i })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole("button", { name: /gemma/ }))
    expect(onSelectModels).toHaveBeenLastCalledWith([
      "qwen/qwen3.8-27b",
      "google/gemma-4-12b-qat",
    ])
    onSelectModels.mockClear()
    rerender(
      <ModelSelector
        multiple
        availableModels={[qwen, gemma]}
        selectedModels={[qwen]}
        onSelectModels={onSelectModels}
        modelsError={null}
      />
    )
    fireEvent.click(screen.getByRole("button", { name: /qwen/ }))
    expect(onSelectModels).not.toHaveBeenCalled()
  })
})

describe("RestrictorDialog", () => {
  it("has a description, so Radix does not warn", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    render(
      <RestrictorDialog
        open
        onOpenChange={() => {}}
        toolCalls={[searchCall]}
        activeIndex={0}
        onActiveIndexChange={() => {}}
      />
    )
    const describedBy = screen
      .getByRole("dialog")
      .getAttribute("aria-describedby")
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy ?? "")).not.toBeNull()
    expect(
      warn.mock.calls.some((args) => String(args[0]).includes("Description"))
    ).toBe(false)
  })

  it("says the full response failed to load and what to do", () => {
    render(
      <RestrictorDialog
        open
        activeIndex={0}
        onActiveIndexChange={() => {}}
        onOpenChange={() => {}}
        toolCalls={[searchCall]}
        fullError="Invalid API key."
        onMeasure={() => {}}
      />
    )
    const message = screen.getByText(/couldn.t fetch the full response/i)
    expect(message.textContent).toMatch(/try again/i)
    expect(message.getAttribute("title")).toBe("Invalid API key.")
    expect(
      screen.getByRole("button", { name: /compare with the full response/i })
    ).toBeTruthy()
  })

  it("runs the comparison from the dialog", () => {
    const onMeasure = vi.fn()
    render(
      <RestrictorDialog
        open
        activeIndex={0}
        onActiveIndexChange={() => {}}
        onOpenChange={() => {}}
        toolCalls={[searchCall]}
        onMeasure={onMeasure}
      />
    )
    fireEvent.click(
      screen.getByRole("button", { name: /compare with the full response/i })
    )
    expect(onMeasure).toHaveBeenCalledTimes(1)
  })
})
