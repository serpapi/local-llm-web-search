import { useState } from "react"
import { ChevronDown, Wrench } from "lucide-react"

import type { Breakdown, ExactUsage } from "@/lib/agent-types"
import type { ModelContextSnapshot } from "@/lib/chat"
import { CONTEXT_SEGMENTS, contextTotal } from "@/lib/agent-types"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

// What filled the model's context on its last call, as a field of cells
// against the window LM Studio loaded. Hovering a part lights up its cells.

// Brand tones for the meaningful movers (tool definitions, tool result,
// final response); neutrals for overhead (system prompt, user message,
// tool call).
const SEGMENT_COLORS: Record<keyof Breakdown, string> = {
  tool_definitions: "bg-serpapi-blue",
  system_prompt: "bg-slate-400 dark:bg-slate-500",
  conversation_history: "bg-indigo-400 dark:bg-indigo-500",
  user_message: "bg-slate-300 dark:bg-slate-600",
  tool_call: "bg-amber-400",
  tool_result: "bg-serpapi-purple",
  final_response: "bg-serpapi-violet",
}

// The field: one cell stands for `limit / CELLS` tokens.
const CELLS = 216
// Share of the window from which the percentage and the caption warn.
const WARN_AT = 0.8

const n = (value: number) => value.toLocaleString("en-US")

export function ContextWindow({
  breakdown,
  fitted,
  exactUsage,
  modelContext,
  searches,
  onInspect,
}: {
  // Fitted to LM Studio's count when `fitted`, cl100k estimates otherwise.
  breakdown: Breakdown
  fitted: boolean
  exactUsage: ExactUsage | null
  modelContext: ModelContextSnapshot | null
  // What each search of the turn returned, in call order, for the tool
  // result's rows.
  searches: Array<{ label: string; tokens: number }>
  onInspect: (index: number) => void
}) {
  const [active, setActive] = useState<keyof Breakdown | null>(null)
  const [open, setOpen] = useState(false)

  const total = contextTotal(breakdown)
  const limit = modelContext?.loaded ?? null
  const share = limit ? total / limit : 0
  const parts = CONTEXT_SEGMENTS.filter((seg) => breakdown[seg.key] > 0)

  // Each part fills cells in the order the context is assembled. Every
  // part keeps one cell, so a small one never disappears, and the rest are
  // shared in proportion to the tokens.
  const perCell = Math.max(limit ?? total, total) / CELLS
  const filled = Math.min(
    CELLS,
    Math.max(parts.length, Math.round(total / perCell))
  )
  const extra = filled - parts.length
  const owner: Array<keyof Breakdown | null> = Array(CELLS).fill(null)
  let end = 0
  let sum = 0
  let shared = 0
  for (const part of parts) {
    sum += breakdown[part.key]
    const upTo = total > 0 ? Math.round((sum / total) * extra) : 0
    const start = end
    end = start + 1 + upTo - shared
    shared = upTo
    owner.fill(part.key, start, end)
  }

  const shown = active
    ? {
        value: breakdown[active],
        label: parts.find((p) => p.key === active)?.label,
      }
    : null
  const level = share >= 1 ? "full" : share >= WARN_AT ? "warn" : "ok"

  return (
    <section aria-label="Context window" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="flex min-w-0 items-baseline gap-1.5">
          <span className="font-mono text-3xl font-semibold tabular-nums">
            {shown ? "" : exactUsage ? "" : "~"}
            {n(shown?.value ?? total)}
          </span>
          <span className="truncate text-sm text-muted-foreground">
            {shown ? (
              shown.label
            ) : limit !== null ? (
              <>
                of <span className="font-mono tabular-nums">{n(limit)}</span>{" "}
                tokens
              </>
            ) : (
              "tokens"
            )}
          </span>
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          {limit !== null ? (
            <span
              className={cn(
                "rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs tabular-nums",
                level === "ok"
                  ? "text-muted-foreground"
                  : level === "warn"
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-destructive"
              )}
            >
              {share > 0 && share < 0.01
                ? "<1%"
                : `${Math.round(share * 100)}%`}
            </span>
          ) : null}
        </div>
      </div>

      {/* Decorative: every number it shows is in the list below. */}
      <div
        aria-hidden
        className="grid grid-cols-[repeat(36,minmax(0,1fr))] gap-[2px]"
        onMouseLeave={() => setActive(null)}
      >
        {owner.map((key, i) => (
          <div
            key={i}
            onMouseEnter={() => setActive(key)}
            className={cn(
              "aspect-square rounded-[1px] transition-opacity duration-200",
              key ? SEGMENT_COLORS[key] : "bg-muted",
              active && key !== active && "opacity-25"
            )}
          />
        ))}
      </div>

      <div className="flex justify-between gap-2 font-mono text-[11px] text-muted-foreground tabular-nums">
        <span
          title={
            exactUsage
              ? "LM Studio's count for the last call. The output includes the tokens the model spent reasoning."
              : "LM Studio sent no usage for this call, so the total is estimated with the cl100k tokenizer."
          }
        >
          {exactUsage
            ? `${n(exactUsage.promptTokens)} in · ${n(exactUsage.completionTokens)} out${
                exactUsage.reasoningTokens
                  ? ` (${n(exactUsage.reasoningTokens)} reasoning)`
                  : ""
              }`
            : "estimated"}
        </span>
        {modelContext && modelContext.max !== modelContext.loaded ? (
          <span>model max {n(modelContext.max)}</span>
        ) : null}
      </div>

      {/* "~" marks an estimate. With LM Studio's usage, the output is its
          exact count and the input parts are estimates scaled to its total. */}
      <ul className="flex flex-col gap-0.5">
        {parts.map((part) => {
          const count = breakdown[part.key]
          const expandable = part.key === "tool_result" && searches.length > 0
          const value = (
            <>
              <span
                aria-hidden
                className={`${SEGMENT_COLORS[part.key]} size-2 shrink-0 rounded-[2px]`}
              />
              <span className="flex min-w-0 flex-1 items-center gap-1 text-left">
                <span className="truncate">{part.label}</span>
                {expandable ? (
                  <ChevronDown
                    aria-hidden
                    className={cn(
                      "size-3.5 shrink-0 text-muted-foreground transition-transform",
                      open && "rotate-180"
                    )}
                  />
                ) : null}
              </span>
              <span className="font-mono tabular-nums">
                {fitted && part.key === "final_response" ? "" : "~"}
                {n(count)}
              </span>
            </>
          )
          const hover = {
            onMouseEnter: () => setActive(part.key),
            onMouseLeave: () => setActive(null),
          }
          if (expandable) {
            return (
              <li key={part.key} {...hover} className="flex flex-col">
                <Button
                  type="button"
                  variant="ghost"
                  aria-expanded={open}
                  onClick={() => setOpen(!open)}
                  onFocus={() => setActive(part.key)}
                  onBlur={() => setActive(null)}
                  className="w-full justify-start gap-2.5"
                >
                  {value}
                </Button>
                {open ? (
                  <ul className="flex flex-col pl-6">
                    {searches.map((search, i) => (
                      <li key={i}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => onInspect(i)}
                          title="Inspect this tool call"
                          className="w-full justify-start gap-2 text-muted-foreground"
                        >
                          <Wrench data-icon="inline-start" aria-hidden />
                          <span className="flex-1 truncate text-left">
                            {search.label}
                          </span>
                          <span className="font-mono tabular-nums">
                            ~{n(search.tokens)}
                          </span>
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            )
          }
          return (
            <li
              key={part.key}
              {...hover}
              title={part.description}
              className="flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-sm transition-colors hover:bg-muted"
            >
              {value}
            </li>
          )
        })}
      </ul>

      <div className="border-t pt-3">
        <span
          aria-live="polite"
          className={cn(
            "text-xs",
            level === "ok"
              ? "text-muted-foreground"
              : level === "warn"
                ? "text-amber-600 dark:text-amber-400"
                : "text-destructive"
          )}
        >
          {limit === null ? null : level === "full" ? (
            "Context window full"
          ) : (
            <>
              <span className="font-mono tabular-nums">
                {n(Math.max(0, limit - total))}
              </span>{" "}
              tokens left
            </>
          )}
        </span>
      </div>
    </section>
  )
}
