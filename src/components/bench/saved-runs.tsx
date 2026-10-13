import { FilePlus, FolderOpen, Loader2, Save } from "lucide-react"

import type { SavedBenchRun } from "@/server/bench"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { cn } from "@/lib/utils"

export type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved"; file: string }
  | { status: "error"; message: string }

/**
 * Persistence for the two tiers above. Runs save themselves after every
 * cell; this card saves a copy under a new name and reopens earlier runs.
 */
export function SavedRuns({
  runs,
  unreadable,
  activeFile,
  onSave,
  canSave,
  saveState,
  onOpen,
  onNewRun,
  canStartNew,
  busy,
}: {
  runs: Array<SavedBenchRun>
  unreadable: Array<string>
  activeFile: string | null
  onSave: () => void
  canSave: boolean
  saveState: SaveState
  onOpen: (run: SavedBenchRun) => void
  onNewRun: () => void
  canStartNew: boolean
  busy: boolean
}) {
  return (
    <Card>
      <CardHeader className="border-b max-sm:has-data-[slot=card-action]:grid-cols-1 max-sm:has-data-[slot=card-description]:grid-rows-[auto_auto_auto]">
        <CardTitle>Saved runs</CardTitle>
        <CardDescription>
          Runs save to{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
            bench/results/
          </code>{" "}
          after every cell.
        </CardDescription>
        <CardAction className="flex items-center gap-2 max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:justify-self-start max-sm:pt-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onNewRun}
            disabled={!canStartNew || busy}
          >
            <FilePlus data-icon="inline-start" aria-hidden />
            New run
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onSave}
            disabled={!canSave || busy || saveState.status === "saving"}
          >
            {saveState.status === "saving" ? (
              <Loader2
                data-icon="inline-start"
                className="animate-spin"
                aria-hidden
              />
            ) : (
              <Save data-icon="inline-start" aria-hidden />
            )}
            Save
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {saveState.status === "error" ? (
          <Alert variant="destructive">
            <AlertTitle>Couldn't save this run</AlertTitle>
            <AlertDescription>{saveState.message}</AlertDescription>
          </Alert>
        ) : null}
        {runs.length === 0 && unreadable.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No saved runs yet.
          </p>
        ) : (
          <ul className="flex flex-col divide-y">
            {runs.map(({ file, run }) => {
              const active = file === activeFile
              return (
                <li key={file} className="py-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="block"
                    onClick={() => onOpen({ file, run })}
                    disabled={busy}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "justify-start gap-3 px-2 py-1.5 text-left",
                      active ? "text-foreground" : "text-muted-foreground"
                    )}
                  >
                    <FolderOpen
                      data-icon="inline-start"
                      className={cn(
                        "size-4 shrink-0",
                        active ? "text-serpapi-blue" : ""
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 font-normal">
                      <span className="block truncate font-mono text-xs">
                        {file}
                      </span>
                      <span className="block text-[11px]">
                        {run.model?.id ?? "no model"} ·{" "}
                        {run.payload.length > 0
                          ? `${new Set(run.payload.map((r) => r.label)).size} tools measured`
                          : "no payload tier"}{" "}
                        · {run.e2e.length} end-to-end{" "}
                        {run.e2e.length === 1 ? "cell" : "cells"}
                      </span>
                    </span>
                    {active ? (
                      <span className="shrink-0 text-[11px] font-medium text-serpapi-blue">
                        Open
                      </span>
                    ) : null}
                  </Button>
                </li>
              )
            })}
            {unreadable.map((file) => (
              <li
                key={file}
                className="flex items-center gap-3 px-2 py-2.5 text-muted-foreground/70"
              >
                <FolderOpen className="size-4 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-mono text-xs line-through">
                    {file}
                  </span>
                  <span className="block text-[11px]">Unreadable format</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
