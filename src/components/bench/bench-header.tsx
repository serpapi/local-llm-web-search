import { Link } from "@tanstack/react-router"
import { ArrowLeft, Moon, Sun } from "lucide-react"

import type { ModelInfo } from "@/lib/agent-types"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ModelSelector } from "@/components/model-selector"

// Sticky header for the benchmark page. Compact on purpose: it stays on
// screen while you scroll a long matrix, so it carries only the title,
// the model picker (which every run reads) and the theme toggle. Picking
// several models runs them one after another.
export function BenchHeader({
  models,
  selectedModels,
  onSelectModels,
  modelsError,
  theme,
  onToggleTheme,
  runName,
  onRunNameChange,
  runNameLocked,
}: {
  models: Array<ModelInfo>
  selectedModels: Array<ModelInfo>
  onSelectModels: (ids: Array<string>) => void
  modelsError: string | null
  theme: "light" | "dark"
  onToggleTheme: () => void
  runName: string
  onRunNameChange: (name: string) => void
  runNameLocked: boolean
}) {
  return (
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <Button asChild variant="outline" size="icon-lg">
          <Link to="/">
            <ArrowLeft aria-hidden />
            <span className="sr-only">Back to chat</span>
          </Link>
        </Button>
        <img
          src="/serpapi-logo.svg"
          alt=""
          className="size-8 shrink-0 rounded-lg shadow-sm"
        />
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-lg leading-tight font-semibold tracking-tight">
            Output benchmark
          </h1>
          <p className="truncate text-xs text-muted-foreground">
            Three SerpApi output modes, same questions.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Input
          aria-label="Run name"
          placeholder="Run name"
          value={runName}
          disabled={runNameLocked}
          onChange={(e) =>
            onRunNameChange(
              e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-")
            )
          }
          className="h-9 w-60 font-mono text-xs"
          spellCheck={false}
        />
        <ModelSelector
          multiple
          availableModels={models}
          selectedModels={selectedModels}
          onSelectModels={onSelectModels}
          modelsError={modelsError}
        />
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          onClick={onToggleTheme}
          aria-label={
            theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
          }
        >
          {theme === "dark" ? <Sun /> : <Moon />}
        </Button>
      </div>
    </header>
  )
}
