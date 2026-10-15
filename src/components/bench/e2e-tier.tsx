import { useState } from "react"
import { ChevronRight, Loader2, Play, Square } from "lucide-react"

import type { ToolOutput } from "@/lib/agent-types"
import type { E2ECell, PayloadMeasurement } from "@/lib/bench-schemas"
import type { ExampleGroup, ExampleQuestion } from "@/lib/examples"
import { TOOL_OUTPUTS, TOOL_OUTPUT_META } from "@/lib/agent-types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  CellSkeleton,
  Delta,
  ModeHeader,
  Outcome,
  Unavailable,
} from "@/components/bench/bench-primitives"
import { CellInspector } from "@/components/bench/cell-inspector"
import {
  cellKey,
  e2eSummary,
  exceedsContext,
  failureLabel,
  formatSeconds,
  formatTokens,
  hitCompletionCap,
  indexCells,
  pairedPromptChange,
  relativeChange,
  usageOf,
} from "@/lib/bench"
import { cn } from "@/lib/utils"

export type E2ETierState =
  | { status: "idle" }
  | { status: "running"; current: string | null; done: number; total: number }
  | { status: "stopping"; current: string | null; done: number; total: number }
  | { status: "error"; message: string }

export type BenchExample = ExampleQuestion & { group: string }

/**
 * End-to-end tier: every selected question through the full agent loop in
 * every selected mode, one cell at a time with a fresh conversation. The
 * numbers are the model's own usage counts and wall-clock time.
 */
export function E2ETier({
  groups,
  examples,
  selected,
  onSetExamples,
  modes,
  onChangeModes,
  cells,
  payload,
  state,
  canRun,
  runDisabledReason,
  modelCount,
  queuedModels,
  onRun,
  onStop,
}: {
  groups: Array<ExampleGroup>
  examples: Array<BenchExample>
  selected: ReadonlySet<string>
  onSetExamples: (labels: Array<string>, checked: boolean) => void
  modes: Array<ToolOutput>
  onChangeModes: (modes: Array<ToolOutput>) => void
  cells: Array<E2ECell>
  // This run's payload rows, for restrictors older runs didn't record.
  payload: Array<PayloadMeasurement>
  state: E2ETierState
  canRun: boolean
  runDisabledReason: string | null
  // Models picked; more than one run one after another.
  modelCount: number
  // Models still queued after the run on screen.
  queuedModels: Array<string>
  onRun: () => void
  onStop: () => void
}) {
  const [inspecting, setInspecting] = useState<E2ECell | null>(null)
  const byKey = indexCells(cells)
  const running = state.status === "running" || state.status === "stopping"
  const visibleExamples = examples.filter((e) => selected.has(e.label))
  const total = visibleExamples.length * modes.length
  const baselineMode: ToolOutput = modes.includes("json") ? "json" : modes[0]

  return (
    <Card>
      <CardHeader className="border-b max-sm:has-data-[slot=card-action]:grid-cols-1 max-sm:has-data-[slot=card-description]:grid-rows-[auto_auto_auto]">
        <CardTitle>End to end</CardTitle>
        <CardDescription>
          Each question through the full agent loop, a minute or more per cell.
        </CardDescription>
        <CardAction className="flex items-center gap-2 max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:justify-self-start max-sm:pt-2">
          {running && queuedModels.length > 0 ? (
            <span className="truncate text-xs text-muted-foreground">
              Next: {queuedModels.map((id) => id.split("/").pop()).join(", ")}
            </span>
          ) : null}
          {running ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onStop}
              disabled={state.status === "stopping"}
            >
              <Square data-icon="inline-start" aria-hidden />
              {state.status === "stopping"
                ? "Stopping after this cell"
                : "Stop after this cell"}
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={onRun}
            disabled={running || !canRun || total === 0}
            title={runDisabledReason ?? undefined}
          >
            {running ? (
              <Loader2
                data-icon="inline-start"
                className="animate-spin"
                aria-hidden
              />
            ) : (
              <Play data-icon="inline-start" aria-hidden />
            )}
            {running
              ? `Running ${Math.min(state.done + 1, state.total)} of ${state.total}`
              : `Run ${total} ${total === 1 ? "cell" : "cells"}${modelCount > 1 ? ` × ${modelCount} models` : ""}`}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
          <fieldset className="flex min-w-0 flex-col gap-5">
            <legend className="mb-3 text-xs font-medium text-muted-foreground">
              Questions
            </legend>
            {groups.map((group) => {
              const labels = group.items.map((ex) => ex.label)
              const picked = labels.filter((l) => selected.has(l))
              const id = `bench-group-${group.title.toLowerCase().replace(/\s+/g, "-")}`
              return (
                <div key={group.title} className="flex flex-col gap-2.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Checkbox
                      id={id}
                      checked={
                        picked.length === labels.length
                          ? true
                          : picked.length > 0
                            ? "indeterminate"
                            : false
                      }
                      disabled={running}
                      onCheckedChange={(v) => onSetExamples(labels, v === true)}
                    />
                    <Label htmlFor={id} className="text-sm font-medium">
                      {group.title}
                    </Label>
                    <span className="font-mono text-xs text-muted-foreground tabular-nums">
                      {picked.length}/{labels.length}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {group.description}
                    </span>
                  </div>
                  <ToggleGroup
                    type="multiple"
                    variant="chip"
                    size="sm"
                    value={picked}
                    disabled={running}
                    aria-label={group.title}
                    onValueChange={(next) => {
                      const on = new Set(next)
                      onSetExamples(
                        labels.filter((l) => on.has(l)),
                        true
                      )
                      onSetExamples(
                        labels.filter((l) => !on.has(l)),
                        false
                      )
                    }}
                    className="flex-wrap"
                  >
                    {group.items.map((ex) => (
                      <ToggleGroupItem
                        key={ex.label}
                        value={ex.label}
                        title={ex.question}
                      >
                        {ex.label}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                </div>
              )
            })}
          </fieldset>
          <fieldset className="flex min-w-0 flex-col">
            <legend className="mb-3 text-xs font-medium text-muted-foreground">
              Output modes
            </legend>
            <ToggleGroup
              type="multiple"
              variant="chip"
              size="sm"
              orientation="vertical"
              value={modes}
              disabled={running}
              aria-label="Output modes"
              onValueChange={(next) => {
                // Keep the canonical order so columns never reshuffle, and
                // never allow an empty selection.
                const ordered = TOOL_OUTPUTS.filter((m) => next.includes(m))
                if (ordered.length > 0) onChangeModes(ordered)
              }}
              className="w-full"
            >
              {TOOL_OUTPUTS.map((m) => (
                <ToggleGroupItem
                  key={m}
                  value={m}
                  title={TOOL_OUTPUT_META[m].description}
                  className="justify-start"
                >
                  {TOOL_OUTPUT_META[m].label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </fieldset>
        </div>

        {running ? (
          <div
            className="flex items-center gap-3"
            role="status"
            aria-live="polite"
          >
            <Progress
              value={state.total ? (state.done / state.total) * 100 : 0}
              className="h-1.5"
            />
            <span className="shrink-0 font-mono text-xs text-muted-foreground tabular-nums">
              {state.done}/{state.total}
              {state.current ? ` · ${state.current}` : ""}
            </span>
          </div>
        ) : null}

        {cells.length > 0 ? (
          <SummaryStrip cells={cells} modes={modes} baseline={baselineMode} />
        ) : null}

        <div className="-mx-4 overflow-x-auto">
          <Table className="min-w-[720px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[220px] pl-4">Question</TableHead>
                {modes.map((m) => (
                  <TableHead key={m} className="text-right">
                    <ModeHeader output={m} baseline={m === baselineMode} />
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleExamples.length === 0 ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={modes.length + 1}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    Pick at least one question to run.
                  </TableCell>
                </TableRow>
              ) : (
                visibleExamples.map((ex) => {
                  const base = byKey.get(cellKey(baselineMode, ex.label))
                  return (
                    <TableRow key={ex.label}>
                      <TableCell className="pl-4 align-top whitespace-normal">
                        <div className="flex flex-col gap-1">
                          <span className="font-medium">{ex.label}</span>
                          <span className="text-[12px] leading-snug text-muted-foreground">
                            {ex.question}
                          </span>
                        </div>
                      </TableCell>
                      {modes.map((m) => {
                        const key = cellKey(m, ex.label)
                        const cell = byKey.get(key)
                        const isCurrent = running && state.current === key
                        return (
                          <TableCell
                            key={m}
                            className="text-right align-top whitespace-normal"
                          >
                            {cell ? (
                              <ResultCell
                                cell={cell}
                                baseline={m === baselineMode ? undefined : base}
                                onInspect={() => setInspecting(cell)}
                              />
                            ) : isCurrent ? (
                              <CellSkeleton />
                            ) : (
                              <Unavailable
                                reason={running ? "Queued" : "Not run yet"}
                              />
                            )}
                          </TableCell>
                        )
                      })}
                    </TableRow>
                  )
                })
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>

      <CellInspector
        cell={inspecting}
        payload={payload}
        onClose={() => setInspecting(null)}
      />
    </Card>
  )
}

function ResultCell({
  cell,
  baseline,
  onInspect,
}: {
  cell: E2ECell
  baseline: E2ECell | undefined
  onInspect: () => void
}) {
  if (cell.status === "failed") {
    return (
      <Button
        type="button"
        variant="outline"
        size="block"
        onClick={onInspect}
        className={cn(
          resultCellClass,
          "border-destructive/30 bg-destructive/5 hover:bg-destructive/10 dark:border-destructive/30 dark:bg-destructive/10 dark:hover:bg-destructive/15"
        )}
        aria-label={`Details for ${cell.label}, ${TOOL_OUTPUT_META[cell.output].label}, failed`}
      >
        <Outcome status="failed" />
        <span className="line-clamp-2 max-w-[260px] text-[11px] font-normal text-muted-foreground">
          {failureLabel(cell.error)}
        </span>
        <span className="font-mono text-[11px] font-normal text-muted-foreground tabular-nums">
          {formatSeconds(cell.elapsedMs)}
        </span>
        <DetailsAffordance />
      </Button>
    )
  }
  const usage = usageOf(cell)
  const basePrompt = baseline ? usageOf(baseline)?.promptTokens : undefined
  const change =
    baseline === undefined
      ? undefined
      : relativeChange(usage?.promptTokens, basePrompt)
  // Older runs lack the flag; a third completion meant the same thing then.
  const retried = cell.retried ?? (cell.totalUsage?.completions ?? 0) > 2
  return (
    <Button
      type="button"
      variant="outline"
      size="block"
      onClick={onInspect}
      className={resultCellClass}
      aria-label={`Details for ${cell.label}, ${TOOL_OUTPUT_META[cell.output].label}`}
    >
      <span
        className="font-mono text-sm font-normal tabular-nums"
        title={
          usage?.basis === "final-call"
            ? "Final-call usage only (older run)."
            : undefined
        }
      >
        {formatTokens(usage?.promptTokens)}
        <span className="ml-1 text-muted-foreground">in</span>
        <span className="mx-1.5 text-muted-foreground/60">·</span>
        {formatTokens(usage?.completionTokens)}
        <span className="ml-1 text-muted-foreground">out</span>
        {usage?.basis === "final-call" ? (
          <span className="ml-1 text-muted-foreground">*</span>
        ) : null}
      </span>
      <span className="flex items-center gap-2 font-mono text-[11px] font-normal text-muted-foreground tabular-nums">
        {formatSeconds(cell.elapsedMs)}
        {baseline !== undefined && change !== undefined && change !== null ? (
          <>
            <span className="text-muted-foreground/60">·</span>
            <Delta change={change} />
            <span>vs {TOOL_OUTPUT_META[baseline.output].short}</span>
          </>
        ) : null}
      </span>
      <span className="flex flex-wrap justify-end gap-1">
        {cell.toolCalls.length === 0 ? (
          <Badge
            variant="outline"
            className="h-4 px-1.5 font-mono text-[10px] text-muted-foreground"
          >
            no tool
          </Badge>
        ) : (
          cell.toolCalls.map((t, i) => (
            <Badge
              key={`${t.name}-${i}`}
              variant="outline"
              className="h-4 px-1.5 font-mono text-[10px]"
            >
              {t.name.replace(/^google_|_search$/g, "")}
            </Badge>
          ))
        )}
        {(cell.toolRounds ?? 1) > 1 ? (
          <Badge
            variant="outline"
            className="h-4 px-1.5 font-mono text-[10px] text-muted-foreground"
            title="The model searched again after reading the results."
          >
            {cell.toolRounds} rounds
          </Badge>
        ) : null}
        {retried ? (
          <Badge
            variant="outline"
            className="h-4 border-amber-500/40 px-1.5 font-mono text-[10px] text-amber-700 dark:text-amber-400"
            title="The answer call returned no prose and was retried."
          >
            retried
          </Badge>
        ) : null}
        {hitCompletionCap(cell) ? (
          <Badge
            variant="outline"
            className="h-4 border-amber-500/40 px-1.5 font-mono text-[10px] text-amber-700 dark:text-amber-400"
            title="The answer stopped at the completion token limit, reasoning included."
          >
            cut off
          </Badge>
        ) : null}
        {exceedsContext(cell) ? (
          <Badge
            variant="outline"
            className="h-4 border-amber-500/40 px-1.5 font-mono text-[10px] text-amber-700 dark:text-amber-400"
            title={`The prompt was larger than the ${formatTokens(cell.loadedContext)}-token context. MLX models run it anyway; GGUF models reject it.`}
          >
            over context
          </Badge>
        ) : null}
      </span>
      <DetailsAffordance />
    </Button>
  )
}

// Every result cell is a button that opens the inspector. The border and
// the trailing "Details" make that obvious without hovering.
const resultCellClass =
  "group flex-col items-end gap-1.5 p-3 text-right hover:border-foreground/30"

function DetailsAffordance() {
  return (
    <span className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground group-hover:text-foreground">
      Details
      <ChevronRight
        className="size-3 transition-transform group-hover:translate-x-0.5"
        aria-hidden
      />
    </span>
  )
}

/** Per-mode totals above the matrix: how many completed, tokens, time. */
function SummaryStrip({
  cells,
  modes,
  baseline,
}: {
  cells: Array<E2ECell>
  modes: Array<ToolOutput>
  baseline: ToolOutput
}) {
  const baselineLabel = TOOL_OUTPUT_META[baseline].short
  return (
    <dl
      className="grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 lg:grid-cols-3"
      aria-label="Per-mode totals"
    >
      {modes.map((m) => {
        const s = e2eSummary(cells, m)
        const ran = s.completed + s.failed
        // Only questions both this mode and the baseline completed, so the
        // two sums cover the same questions.
        const paired =
          m === baseline ? null : pairedPromptChange(cells, m, baseline)
        return (
          <div key={m} className="flex flex-col gap-2 bg-card p-4">
            <dt className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {TOOL_OUTPUT_META[m].label}
              </span>
              <span>
                {ran === 0
                  ? "not run"
                  : `${s.completed} completed${s.failed ? `, ${s.failed} failed` : ""}`}
              </span>
            </dt>
            <dd className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-2xl tracking-tight tabular-nums">
                {formatTokens(s.promptTokens)}
                <span className="ml-1.5 text-sm text-muted-foreground">in</span>
              </span>
              {paired !== null ? (
                <span className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
                  <Delta change={paired.change} />
                  vs {baselineLabel}
                </span>
              ) : ran > 0 ? (
                <span className="text-xs text-muted-foreground">baseline</span>
              ) : null}
            </dd>
            <dd className="flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
              <span>{formatTokens(s.completionTokens)} out</span>
              <span>{formatSeconds(s.elapsedMs)} total</span>
            </dd>
            {paired !== null &&
            paired.questions > 0 &&
            paired.questions < s.completed - s.usageMissing ? (
              <dd className="text-[11px] text-muted-foreground">
                Compared on {paired.questions} shared{" "}
                {paired.questions === 1 ? "question" : "questions"}.
              </dd>
            ) : null}
            {s.usageMissing > 0 ? (
              <dd className="text-[11px] text-amber-700 dark:text-amber-400">
                {s.usageMissing} {s.usageMissing === 1 ? "cell" : "cells"}{" "}
                without usage, excluded.
              </dd>
            ) : null}
            {s.finalCallOnly > 0 ? (
              <dd className="text-[11px] text-muted-foreground">
                * Final-call usage only (older run).
              </dd>
            ) : null}
          </div>
        )
      })}
    </dl>
  )
}
