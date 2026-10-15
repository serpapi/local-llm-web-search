import { FlaskConical } from "lucide-react"

import type { ToolOutput } from "@/lib/agent-types"
import type { E2ECell, PayloadMeasurement } from "@/lib/bench-schemas"
import { TOOL_OUTPUT_META } from "@/lib/agent-types"
import { RestrictorPaths } from "@/components/restrictor-paths"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Markdown } from "@/components/ui/markdown"
import { Outcome } from "@/components/bench/bench-primitives"
import { formatSeconds, formatTokens } from "@/lib/bench"

/**
 * Everything behind one end-to-end cell, in the same dialog shell as the
 * chat's tool-call inspector: the answer as the model wrote it on the
 * left, usage and timing on the right.
 */
export function CellInspector({
  cell,
  payload,
  onClose,
}: {
  cell: E2ECell | null
  // The same run's payload rows: they record the restrictor for runs
  // saved before tool calls carried their own.
  payload: Array<PayloadMeasurement>
  onClose: () => void
}) {
  return (
    <Dialog open={cell !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[90svh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(1100px,94vw)]">
        {cell ? (
          <>
            <DialogHeader className="border-b px-6 py-5 text-left">
              <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className="gap-1 font-mono text-[10px]"
                >
                  <FlaskConical aria-hidden />
                  {cell.label}
                </Badge>
                <Badge variant="secondary" className="text-[10px]">
                  {TOOL_OUTPUT_META[cell.output].label}
                </Badge>
                <Outcome status={cell.status} />
              </div>
              <DialogTitle className="text-base leading-snug font-medium">
                {cell.question}
              </DialogTitle>
              <DialogDescription className="font-mono text-xs tabular-nums">
                {cell.elapsedMs === null
                  ? "Time not recorded"
                  : cell.status === "completed"
                    ? `${formatSeconds(cell.elapsedMs)} end to end`
                    : `Failed after ${formatSeconds(cell.elapsedMs)}`}
              </DialogDescription>
            </DialogHeader>
            <InspectorBody cell={cell} payload={payload} />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function InspectorBody({
  cell,
  payload,
}: {
  cell: E2ECell
  payload: Array<PayloadMeasurement>
}) {
  return cell.status === "failed" ? (
    <div className="flex flex-col gap-5 overflow-y-auto px-6 py-5">
      <div>
        <p className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm leading-relaxed text-destructive">
          {cell.error}
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          Excluded from the totals.
        </p>
      </div>
      {cell.rawReply ? (
        <section>
          <h3 className="mb-2 text-sm font-medium">Model's last reply</h3>
          <pre className="max-h-64 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {cell.rawReply.trim()}
          </pre>
        </section>
      ) : null}
      {cell.toolCalls && cell.toolCalls.length > 0 ? (
        <ToolCallList
          calls={cell.toolCalls}
          output={cell.output}
          payload={payload}
        />
      ) : null}
    </div>
  ) : (
    <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_400px] lg:overflow-hidden">
      <section className="min-h-0 border-b px-6 py-5 lg:overflow-y-auto lg:border-r lg:border-b-0">
        <h3 className="mb-3 text-sm font-medium">Answer</h3>
        <Markdown preset="typeset-compact">{cell.answer}</Markdown>
      </section>

      <aside className="flex min-h-0 flex-col gap-6 px-6 py-5 lg:overflow-y-auto">
        <dl className="grid shrink-0 grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border">
          <Stat
            label="Input, whole turn"
            value={formatTokens(cell.totalUsage?.promptTokens)}
            hint={
              cell.totalUsage
                ? `${cell.totalUsage.completions} completion${cell.totalUsage.completions === 1 ? "" : "s"}`
                : "Not reported"
            }
          />
          <Stat
            label="Output, whole turn"
            value={formatTokens(cell.totalUsage?.completionTokens)}
            hint="Includes reasoning tokens"
          />
          <Stat
            label="Input, final call"
            value={formatTokens(cell.finalUsage?.promptTokens)}
            hint="What the model read to answer"
          />
          <Stat
            label="Tool result"
            value={formatTokens(cell.toolResultTokens)}
            hint="cl100k estimate"
          />
        </dl>

        <section>
          <h3 className="mb-2 text-sm font-medium">Where the time went</h3>
          <PhaseBar phases={cell.phases} direct={cell.toolCalls.length === 0} />
        </section>

        {cell.toolCalls.length > 0 ? (
          <ToolCallList
            calls={cell.toolCalls}
            output={cell.output}
            payload={payload}
          />
        ) : null}
      </aside>
    </div>
  )
}

type SavedToolCall = NonNullable<
  Extract<E2ECell, { status: "failed" }>["toolCalls"]
>[number]

// The restrictor a saved call ran with: recorded on the call, or, in runs
// saved before that, the restrictor this run's payload tier used for the
// same tool and output. `undefined` when neither recorded it.
function savedRestrictor(
  call: SavedToolCall,
  output: ToolOutput,
  payload: Array<PayloadMeasurement>
): string | null | undefined {
  if (call.restrictor !== undefined) return call.restrictor
  if (output === "markdown-full") return null
  return (
    payload.find((p) => p.tool === call.name && p.output === output)
      ?.restrictor ?? undefined
  )
}

function ToolCallList({
  calls,
  output,
  payload,
}: {
  calls: Array<SavedToolCall>
  output: ToolOutput
  payload: Array<PayloadMeasurement>
}) {
  return (
    <section>
      <h3 className="mb-2 text-sm font-medium">
        {calls.length === 1 ? "Tool call" : `${calls.length} tool calls`}
      </h3>
      <ul className="flex flex-col gap-2">
        {calls.map((t, i) => (
          <li
            key={`${t.name}-${i}`}
            className="rounded-lg border bg-muted/30 p-3 text-xs"
          >
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="font-mono font-medium">{t.name}</span>
              <span className="font-mono text-muted-foreground tabular-nums">
                {t.tokens === null || t.serpApiMs === null
                  ? "not recorded"
                  : `${formatTokens(t.tokens)} tok · ${t.serpApiMs} ms`}
              </span>
            </div>
            {Object.keys(t.args).length > 0 ? (
              <pre className="overflow-x-auto font-mono text-[11px] leading-relaxed text-muted-foreground">
                {JSON.stringify(t.args, null, 2)}
              </pre>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Arguments not recorded.
              </p>
            )}
            <RestrictorSection
              restrictor={savedRestrictor(t, output, payload)}
              output={output}
            />
          </li>
        ))}
      </ul>
    </section>
  )
}

function RestrictorSection({
  restrictor,
  output,
}: {
  restrictor: string | null | undefined
  output: ToolOutput
}) {
  return (
    <div className="mt-3 flex flex-col gap-2 border-t pt-3">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-[11px] font-medium">JSON Restrictor</h4>
        <span className="text-[11px] text-muted-foreground">
          {TOOL_OUTPUT_META[output].label}
        </span>
      </div>
      {restrictor ? (
        <RestrictorPaths restrictor={restrictor} />
      ) : (
        <p className="text-[11px] text-muted-foreground">
          {restrictor === null
            ? "None. The model read the full response."
            : "Not recorded in this run."}
        </p>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint: string
}) {
  return (
    <div className="flex flex-col gap-1 bg-card p-3">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="font-mono text-xl tracking-tight tabular-nums">{value}</dd>
      <dd className="text-[11px] leading-snug text-muted-foreground">{hint}</dd>
    </div>
  )
}

function PhaseBar({
  phases,
  direct,
}: {
  phases: {
    firstInferenceMs: number | null
    toolExecutionMs: number | null
    secondInferenceMs: number | null
  }
  direct: boolean
}) {
  // Unrecorded phases (null, older runs) are left out rather than drawn as zero.
  const segments = [
    {
      key: "first",
      label: direct ? "Answer" : "Pick tool",
      ms: phases.firstInferenceMs,
      color: "bg-serpapi-blue",
    },
    {
      key: "tools",
      label: "SerpApi",
      ms: phases.toolExecutionMs,
      color: "bg-serpapi-purple",
    },
    {
      key: "second",
      label: "Answer",
      ms: phases.secondInferenceMs,
      color: "bg-serpapi-violet",
    },
  ].flatMap((s) => (s.ms !== null && s.ms > 0 ? [{ ...s, ms: s.ms }] : []))
  const total = segments.reduce((sum, s) => sum + s.ms, 0)
  if (total === 0) {
    return (
      <p className="text-xs text-muted-foreground">No phase timing recorded.</p>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
        {segments.map((s) => (
          <div
            key={s.key}
            className={s.color}
            style={{ width: `${(s.ms / total) * 100}%` }}
            title={`${s.label}: ${s.ms} ms`}
          />
        ))}
      </div>
      <ul className="flex flex-col gap-1 text-[11px]">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={`${s.color} size-1.5 shrink-0 rounded-full`}
            />
            <span className="flex-1 truncate text-muted-foreground">
              {s.label}
            </span>
            <span className="font-mono tabular-nums">
              {formatSeconds(s.ms)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
