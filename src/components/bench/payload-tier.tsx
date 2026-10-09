import { Loader2, Play } from "lucide-react"

import type { PayloadCall } from "@/lib/bench"
import type { PayloadMeasurement } from "@/server/bench"
import { PAYLOAD_OUTPUTS } from "@/lib/agent-types"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  CellSkeleton,
  Delta,
  Hint,
  ModeHeader,
  Unavailable,
} from "@/components/bench/bench-primitives"
import {
  cellKey,
  formatKb,
  formatTokens,
  indexPayload,
  measuredTokens,
  payloadTotals,
  relativeChange,
} from "@/lib/bench"

export type PayloadTierState =
  | { status: "idle" }
  | { status: "running"; current: string | null }
  | { status: "error"; message: string }

/**
 * Payload tier: one SerpApi call per tool per mode, no model. Answers
 * "how much does the model have to read?" in tokens, before inference
 * ever enters the picture.
 */
export function PayloadTier({
  calls,
  rows,
  state,
  onRun,
}: {
  calls: Array<PayloadCall>
  rows: Array<PayloadMeasurement>
  state: PayloadTierState
  onRun: () => void
}) {
  const byKey = indexPayload(rows)
  const totals = payloadTotals(rows)
  const running = state.status === "running"
  const credits = calls.length * PAYLOAD_OUTPUTS.length
  const measuredEverything = PAYLOAD_OUTPUTS.every(
    (m) => totals[m].count + totals[m].errors === calls.length
  )

  return (
    <Card>
      <CardHeader className="border-b max-sm:has-data-[slot=card-action]:grid-cols-1 max-sm:has-data-[slot=card-description]:grid-rows-[auto_auto_auto]">
        <CardTitle>Payload size</CardTitle>
        <CardDescription>
          Size of each tool result from SerpApi, with no model.
        </CardDescription>
        <CardAction className="max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:justify-self-start max-sm:pt-2">
          <Button size="sm" onClick={onRun} disabled={running}>
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
              ? `Measuring ${state.current ?? ""}`
              : rows.length > 0
                ? `Measure again (${credits} credits)`
                : `Measure (${credits} credits)`}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="overflow-x-auto px-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-4">Tool</TableHead>
              {PAYLOAD_OUTPUTS.map((m) => (
                <TableHead key={m} className="text-right">
                  <ModeHeader output={m} baseline={m === "json"} />
                </TableHead>
              ))}
              {DELTA_COLUMNS.map((col, i) => (
                <TableHead
                  key={col.title}
                  className={cn(
                    "w-28 text-right whitespace-normal",
                    i === DELTA_COLUMNS.length - 1 && "pr-4"
                  )}
                >
                  <Hint
                    label={`${col.title}. ${col.hint}`}
                    hint={col.hint}
                    className="decoration-border underline-offset-4"
                  >
                    {col.title}
                  </Hint>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {calls.map((c) => {
              const jsonFull = byKey.get(cellKey("json-full", c.label))
              const json = byKey.get(cellKey("json", c.label))
              const md = byKey.get(cellKey("markdown", c.label))
              const raw = byKey.get(cellKey("markdown-full", c.label))
              const isCurrent = running && state.current === c.label
              return (
                <TableRow key={c.label}>
                  <TableCell className="pl-4 align-top">
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">{c.label}</span>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {c.name}
                      </span>
                    </div>
                  </TableCell>
                  {PAYLOAD_OUTPUTS.map((mode) => {
                    const r = byKey.get(cellKey(mode, c.label))
                    return (
                      <TableCell key={mode} className="text-right align-top">
                        {r ? (
                          <PayloadCell row={r} />
                        ) : isCurrent ? (
                          <CellSkeleton />
                        ) : (
                          <Unavailable />
                        )}
                      </TableCell>
                    )
                  })}
                  <TableCell className="text-right align-top">
                    <Delta
                      change={relativeChange(
                        measuredTokens(json),
                        measuredTokens(jsonFull)
                      )}
                    />
                  </TableCell>
                  <TableCell className="text-right align-top">
                    <Delta
                      change={relativeChange(
                        measuredTokens(md),
                        measuredTokens(json)
                      )}
                    />
                  </TableCell>
                  <TableCell className="pr-4 text-right align-top">
                    <Delta
                      change={relativeChange(
                        measuredTokens(raw),
                        measuredTokens(md)
                      )}
                    />
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
          {rows.length > 0 ? (
            <TableFooter>
              <TableRow className="hover:bg-transparent">
                <TableCell className="pl-4 text-xs text-muted-foreground">
                  Total across {calls.length} tools
                  {measuredEverything ? "" : " (partial)"}
                </TableCell>
                {PAYLOAD_OUTPUTS.map((m) => (
                  <TableCell
                    key={m}
                    className="text-right font-mono text-sm tabular-nums"
                  >
                    {totals[m].count > 0 ? formatTokens(totals[m].tokens) : "–"}
                    {totals[m].errors > 0 ? (
                      <span className="ml-1 text-[11px] text-destructive">
                        {totals[m].errors} failed
                      </span>
                    ) : null}
                  </TableCell>
                ))}
                <TableCell className="text-right">
                  <Delta
                    change={relativeChange(
                      totals.json.count === calls.length
                        ? totals.json.tokens
                        : undefined,
                      totals["json-full"].count === calls.length
                        ? totals["json-full"].tokens
                        : undefined
                    )}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <Delta
                    change={relativeChange(
                      totals.markdown.count === calls.length
                        ? totals.markdown.tokens
                        : undefined,
                      totals.json.count === calls.length
                        ? totals.json.tokens
                        : undefined
                    )}
                  />
                </TableCell>
                <TableCell className="pr-4 text-right">
                  <Delta
                    change={relativeChange(
                      totals["markdown-full"].count === calls.length
                        ? totals["markdown-full"].tokens
                        : undefined,
                      totals.markdown.count === calls.length
                        ? totals.markdown.tokens
                        : undefined
                    )}
                  />
                </TableCell>
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </CardContent>
    </Card>
  )
}

// The three comparison columns after the per-mode sizes.
const DELTA_COLUMNS = [
  {
    title: "Restrictor vs raw JSON",
    hint: "What the restrictor removed from the JSON.",
  },
  {
    title: "Markdown vs JSON",
    hint: "Same restrictor, different serialisation.",
  },
  { title: "Raw vs Markdown", hint: "What the restrictor removed." },
]

function PayloadCell({ row }: { row: PayloadMeasurement }) {
  if (row.error !== null) {
    return (
      <Hint
        label={`Failed: ${row.error}`}
        hint={row.error}
        side="left"
        className="text-xs font-medium text-destructive underline-offset-2"
      >
        Failed
      </Hint>
    )
  }
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="font-mono text-sm tabular-nums">
        {formatTokens(row.tokens)}
        <span className="ml-1 text-muted-foreground">tok</span>
      </span>
      <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
        {formatKb(row.bytes)} · {row.serpApiMs} ms
      </span>
    </div>
  )
}
