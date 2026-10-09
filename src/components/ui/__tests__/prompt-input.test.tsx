import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"

import { PromptInput, PromptInputTextarea } from "../prompt-input"

function renderComposer(onSubmit: () => void) {
  render(
    <PromptInput value="hola" onValueChange={() => {}} onSubmit={onSubmit}>
      <PromptInputTextarea aria-label="Chat input" />
    </PromptInput>
  )
  return screen.getByLabelText("Chat input")
}

afterEach(cleanup)

describe("PromptInputTextarea", () => {
  it("submits on Enter", () => {
    const onSubmit = vi.fn()
    fireEvent.keyDown(renderComposer(onSubmit), { key: "Enter" })
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("adds a line on Shift+Enter", () => {
    const onSubmit = vi.fn()
    fireEvent.keyDown(renderComposer(onSubmit), {
      key: "Enter",
      shiftKey: true,
    })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  // Japanese, Chinese and Korean input methods confirm a word with Enter.
  it("does not submit while an IME composition is open", () => {
    const onSubmit = vi.fn()
    fireEvent.keyDown(renderComposer(onSubmit), {
      key: "Enter",
      isComposing: true,
    })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  // Safari ends the composition before the confirming keydown and flags
  // that keydown with keyCode 229 instead.
  it("does not submit on the Enter that confirms a composition in Safari", () => {
    const onSubmit = vi.fn()
    fireEvent.keyDown(renderComposer(onSubmit), { key: "Enter", keyCode: 229 })
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
