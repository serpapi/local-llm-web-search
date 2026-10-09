import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"

import { useTheme } from "../use-theme"
import { ThemeProvider } from "@/components/theme-provider"

function ThemeLabel() {
  return <span data-testid="theme">{useTheme().theme}</span>
}

function renderApp() {
  render(
    <ThemeProvider>
      <ThemeLabel />
      <div role="menu" data-radix-menu-content="">
        <div role="menuitemradio" tabIndex={-1}>
          Dark model
        </div>
      </div>
      <button type="button">Plain button</button>
    </ThemeProvider>
  )
  return () => screen.getByTestId("theme").textContent
}

beforeEach(() => {
  // jsdom has no matchMedia; the provider reads the OS preference from it.
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false }) as unknown as MediaQueryList)
  )
  window.localStorage.clear()
  document.documentElement.classList.remove("dark")
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("ThemeProvider", () => {
  it("toggles the theme with d", () => {
    const theme = renderApp()
    fireEvent.keyDown(screen.getByText("Plain button"), { key: "d" })
    expect(theme()).toBe("dark")
    expect(document.documentElement.classList.contains("dark")).toBe(true)
  })

  it("ignores d typed into an open menu", () => {
    const theme = renderApp()
    fireEvent.keyDown(screen.getByRole("menu"), { key: "d" })
    expect(theme()).toBe("light")
    fireEvent.keyDown(screen.getByText("Dark model"), { key: "d" })
    expect(theme()).toBe("light")
  })

  it("ignores d while a modifier key is held", () => {
    const theme = renderApp()
    const target = screen.getByText("Plain button")
    for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"]) {
      fireEvent.keyDown(target, { key: "d", [modifier]: true })
      expect(theme()).toBe("light")
    }
  })

  it("still renders and toggles when storage is blocked", () => {
    const blocked = () => {
      throw new DOMException("The operation is insecure.", "SecurityError")
    }
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(blocked)
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(blocked)
    const theme = renderApp()
    expect(theme()).toBe("light")
    act(() => {
      fireEvent.keyDown(screen.getByText("Plain button"), { key: "d" })
    })
    expect(theme()).toBe("dark")
  })
})
