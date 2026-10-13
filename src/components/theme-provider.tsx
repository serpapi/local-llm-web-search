import { useCallback, useEffect, useMemo, useState } from "react"
import type { ReactNode } from "react"

import type { Theme } from "@/hooks/use-theme"
import { THEME_STORAGE_KEY, ThemeContext } from "@/hooks/use-theme"

/**
 * Light/dark theme with persistence. Reads the stored choice (or the OS
 * preference) after mount so SSR markup stays deterministic, and mirrors
 * the choice onto `<html class="dark">` for the Tailwind `dark:` variant.
 * Pressing `d` outside a text field or menu toggles it.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>("light")

  useEffect(() => {
    const stored = readStoredTheme()
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)"
    ).matches
    const initial: Theme =
      stored === "dark" || stored === "light"
        ? stored
        : prefersDark
          ? "dark"
          : "light"
    setTheme(initial)
    document.documentElement.classList.toggle("dark", initial === "dark")
  }, [])

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next: Theme = current === "dark" ? "light" : "dark"
      document.documentElement.classList.toggle("dark", next === "dark")
      storeTheme(next)
      return next
    })
  }, [])

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.key.toLowerCase() !== "d" ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.repeat ||
        event.defaultPrevented ||
        isEditableTarget(event.target) ||
        isInsideMenu(event.target)
      ) {
        return
      }
      event.preventDefault()
      toggleTheme()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [toggleTheme])

  const value = useMemo(() => ({ theme, toggleTheme }), [theme, toggleTheme])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  )
}

// WHY: Radix menus jump to the item whose label starts with the typed
//      letter, so "d" there picks an item, not the theme.
function isInsideMenu(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      '[role="menu"], [role^="menuitem"], [data-radix-menu-content]'
    ) !== null
  )
}

// WHY: storage throws when the browser blocks it (strict privacy settings,
//      some embedded views). This runs in the root shell, outside the route
//      error boundaries, so a throw would blank the app; fall back to the OS
//      preference instead.
function readStoredTheme(): string | null {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY)
  } catch {
    return null
  }
}

function storeTheme(theme: Theme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  } catch {
    // The choice then lasts until the page reloads.
  }
}
