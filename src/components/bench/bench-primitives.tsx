import { AlertCircle, Check, Minus } from "lucide-react"

import type { ReactNode } from "react"
import type { PayloadOutput } from "@/lib/agent-types"
import { PAYLOAD_OUTPUT_META } from "@/lib/agent-types"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { formatChange } from "@/lib/bench"

// Small presentational pieces shared by both benchmark tables.

/**
 * Text with a tooltip that opens on hover or keyboard focus. `label` is the
 * accessible name, so it should carry the hint too.
 */
export function Hint({
  label,
  hint,
  side = "top",
  className,
  children,
}: {
  label: string
  hint: string
  side?: "top" | "left"
  className?: string
  children: ReactNode
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={label}
          className={cn(
            "cursor-help rounded-sm underline decoration-dotted outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
            className
          )}
        >
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent side={side} className="max-w-xs">
        {hint}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * Column header for one output mode, with the baseline marked. The mode's
 * description lives in a tooltip so six columns fit without scrolling.
 */
export function ModeHeader({
  output,
  baseline,
}: {
  output: PayloadOutput
  baseline?: boolean
}) {
  const meta = PAYLOAD_OUTPUT_META[output]
  return (
    <Hint
      label={`${meta.label}${baseline ? ", baseline" : ""}. ${meta.description}`}
      hint={meta.description}
      className="inline-flex items-center gap-1.5 font-medium text-foreground decoration-border underline-offset-4"
    >
      {meta.label}
      {baseline ? (
        <Badge
          variant="outline"
          className="h-4 px-1.5 text-[10px] font-normal text-muted-foreground"
        >
          baseline
        </Badge>
      ) : null}
    </Hint>
  )
}

/** A value that hasn't been measured or can't be compared. */
export function Unavailable({ reason }: { reason?: string }) {
  const dash = (
    <span
      aria-label={reason ?? "Not measured"}
      className="inline-flex items-center text-muted-foreground/70"
    >
      <Minus className="size-3.5" aria-hidden />
    </span>
  )
  if (!reason) return dash
  return (
    <Tooltip>
      <TooltipTrigger asChild>{dash}</TooltipTrigger>
      <TooltipContent side="top">{reason}</TooltipContent>
    </Tooltip>
  )
}

/** Signed delta against the baseline. Green when smaller, muted otherwise. */
export function Delta({
  change,
  invert = false,
}: {
  change: number | null
  /** When true, a positive change is the good direction. */
  invert?: boolean
}) {
  if (change === null) return <Unavailable reason="Not comparable" />
  const better = invert ? change > 0 : change < 0
  const worse = invert ? change < 0 : change > 0
  return (
    <span
      className={cn(
        "font-mono text-sm tabular-nums",
        better && "text-emerald-700 dark:text-emerald-400",
        worse && "text-foreground",
        !better && !worse && "text-muted-foreground"
      )}
    >
      {formatChange(change)}
    </span>
  )
}

export function Outcome({ status }: { status: "completed" | "failed" }) {
  return status === "failed" ? (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive">
      <AlertCircle className="size-3.5" aria-hidden />
      Failed
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <Check className="size-3.5" aria-hidden />
      Completed
    </span>
  )
}

/** Running-cell placeholder that keeps the row height stable. */
export function CellSkeleton() {
  return (
    <div className="flex flex-col items-end gap-1.5" aria-label="Measuring">
      <Skeleton className="h-4 w-20" />
      <Skeleton className="h-3 w-28" />
    </div>
  )
}
