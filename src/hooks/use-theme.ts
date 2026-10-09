import { createContext, useContext } from "react"

export type Theme = "light" | "dark"

export const THEME_STORAGE_KEY = "local-llm-web-search:theme"

export type ThemeContextValue = {
  theme: Theme
  toggleTheme: () => void
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

/** The app-wide light/dark theme. Requires `ThemeProvider` in the root shell. */
export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext)
  if (context === null) {
    throw new Error("useTheme must be used inside ThemeProvider")
  }
  return context
}
