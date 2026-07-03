import { useState } from "react"
import { ArrowDown, ArrowRight, Wrench } from "lucide-react"

import type {
  FullResponseResult,
  JsonValue,
  ToolCallInfo,
} from "@/server/agent"
import { Badge } from "@/components/ui/badge"
import { CodeBlock, CodeBlockCode } from "@/components/ui/code-block"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { TextShimmerLoader } from "@/components/ui/loader"
import { cn } from "@/lib/utils"

// Short label per tool call for the tab when parallel calls happened.
// Matches the `toolCallLabel` on the server but lives here because the
// frontend doesn't import runtime from that module.
function toolCallLabel(tc: ToolCallInfo): string {
  const a = tc.args as Record<string, string | number | boolean | null>
  switch (tc.name) {
    case "google_search":
      return `Search · ${a.query ?? ""}`
    case "google_finance_search":
      return `Finance · ${a.query ?? ""}`
    case "google_news_search":
      return `News · ${a.query ?? ""}`
    case "google_maps_search":
      return `Maps · ${a.query ?? ""}`
    case "google_flights_search":
      return `Flights · ${a.departure_id ?? "?"} → ${a.arrival_id ?? "?"}`
    default:
      return tc.name
  }
}

// Split a restrictor string into its top-level paths, one per card. Commas
// inside `{…}` projections or `[…]` slices belong to a nested path, so we
// only break on commas at depth zero.
function splitTopLevelPaths(restrictor: string): Array<string> {
  const paths: Array<string> = []
  let depth = 0
  let current = ""
  for (const ch of restrictor) {
    if (ch === "{" || ch === "[") depth += 1
    else if (ch === "}" || ch === "]") depth -= 1
    if (ch === "," && depth === 0) {
      paths.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  if (current) paths.push(current)
  return paths.map((p) => p.trim()).filter(Boolean)
}

// Split one path into the object/array it selects from and the fields it
// keeps. `organic_results[0:5].{title,link}` → head `organic_results[0:5]`,
// fields `[title, link]`. A path with no projection keeps the whole node.
function parseRestrictorPath(path: string): {
  head: string
  fields: Array<string>
} {
  const braceStart = path.indexOf(".{")
  if (braceStart === -1 || !path.endsWith("}")) {
    return { head: path, fields: [] }
  }
  const head = path.slice(0, braceStart)
  const inner = path.slice(braceStart + 2, -1)
  return { head, fields: splitTopLevelPaths(inner) }
}

// A field is itself a projection when it carries its own `.{…}` — e.g.
// `flights[].{airline,…}` keeps a node and selects from inside it. Those
// recurse into nested groups; everything else is a leaf chip.
function isProjection(path: string): boolean {
  return parseRestrictorPath(path).fields.length > 0
}

export function RestrictorDialog({
  open,
  onOpenChange,
  toolCalls,
  fullResults,
  fullLoading,
  theme,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  toolCalls: Array<ToolCallInfo>
  // Full (unrestricted) responses for the turn, aligned by index with
  // `toolCalls`. Undefined while loading or when the call fell back.
  fullResults?: Array<FullResponseResult>
  fullLoading?: boolean
  theme: "light" | "dark"
}) {
  const [activeIndex, setActiveIndex] = useState(0)
  const index =
    toolCalls.length > 0 ? Math.min(activeIndex, toolCalls.length - 1) : 0
  const call = toolCalls.length > 0 ? toolCalls[index] : null

  if (!call) return null

  const paths = splitTopLevelPaths(call.restrictor)
  const args = call.args as Record<string, string | number | boolean | null>
  const full = fullResults?.[index] ?? null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col gap-4 sm:max-w-[min(1700px,96vw)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="h-4 w-4" />
            Tool call
          </DialogTitle>
          <DialogDescription>
            The full response from SerpApi (left), the fields the JSON
            Restrictor keeps (middle), and the filtered result the model
            receives (right).
          </DialogDescription>
        </DialogHeader>

        {toolCalls.length > 1 ? (
          <div className="flex flex-wrap gap-1.5 border-b pb-3">
            {toolCalls.map((tc, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setActiveIndex(i)}
                className={cn(
                  "rounded-md border px-2.5 py-1 font-mono text-xs transition-colors",
                  i === index
                    ? "border-primary bg-primary/10 text-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                )}
              >
                {toolCallLabel(tc)}
              </button>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge
            variant="outline"
            className="gap-1 font-mono text-[11px] tracking-wide uppercase"
          >
            {call.name}
          </Badge>
          {Object.entries(args).map(([k, v]) => (
            <span
              key={k}
              className="font-mono text-muted-foreground tabular-nums"
            >
              {k}: <span className="text-foreground">{String(v)}</span>
            </span>
          ))}
        </div>

        <div className="grid min-h-0 flex-1 items-start gap-3 overflow-hidden md:grid-cols-[minmax(0,1fr)_auto_minmax(0,300px)_auto_minmax(0,1fr)]">
          {/* Raw — the full response SerpApi would return without a restrictor */}
          <PaneHeading
            heading="Full response"
            subheading={full ? `${full.tokens.toLocaleString()} tokens` : ""}
          >
            {full ? (
              <JsonCode value={full.response} theme={theme} />
            ) : (
              <div className="flex items-center rounded-xl border bg-muted/40 p-3">
                {fullLoading ? (
                  <TextShimmerLoader
                    text="Fetching the full response…"
                    size="sm"
                  />
                ) : (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    The full response wasn&rsquo;t measured for this call.
                  </p>
                )}
              </div>
            )}
          </PaneHeading>

          <Arrow />

          {/* Middle — the filter itself: the kept fields as cards at the
              top, and the payload reduction pinned at the bottom so the
              column reads top-to-bottom as "these fields → this result". */}
          <div className="flex min-h-0 flex-col gap-3 self-stretch">
            <h3 className="text-sm font-semibold">JSON Restrictor keeps</h3>
            <div className="-mr-1 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1">
              {paths.map((path, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-border/60 bg-muted/40 p-2.5"
                >
                  <RestrictorNode path={path} />
                </div>
              ))}
            </div>

            {full ? (
              <div className="flex flex-col gap-2 pt-3">
                <div className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
                  <ArrowDown className="h-3 w-3" />
                  narrows to
                </div>
                <div className="flex flex-col gap-1 rounded-lg border border-border/60 bg-muted/40 p-3">
                  <div className="flex items-baseline gap-1.5">
                    <span className="font-mono text-xl font-semibold tabular-nums">
                      {full.tokens > 0
                        ? Math.max(
                            0,
                            Math.round((1 - call.tokens / full.tokens) * 100)
                          )
                        : 0}
                      %
                    </span>
                    <span className="text-xs text-muted-foreground">
                      smaller
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    {full.tokens.toLocaleString()} →{" "}
                    {call.tokens.toLocaleString()} tokens
                  </div>
                  <div className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    {(full.serpApiMs / 1000).toFixed(2)}s →{" "}
                    {(call.serpApiMs / 1000).toFixed(2)}s fetch
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          <Arrow />

          {/* Filtered — exactly what the model received */}
          <PaneHeading
            heading="Filtered for the model"
            subheading={`${call.tokens.toLocaleString()} tokens`}
          >
            <JsonCode value={call.response} theme={theme} />
          </PaneHeading>
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Render one restrictor path as a node: its head as a mono label, then its
// fields below. Leaf fields collapse into a single wrapping row of chips;
// fields that are themselves projections (`flights[].{…}`) recurse into a
// nested node, indented under a guide line. This mirrors the shape of the
// kept data, so a deeply nested flights restrictor reads as a tree that
// wraps inside the column instead of one long chip that overflows it.
function RestrictorNode({ path, depth = 0 }: { path: string; depth?: number }) {
  const { head, fields } = parseRestrictorPath(path)
  // WHY: split leaves from nested projections so the short scalar fields
  //      stay packed together as chips and the nested ones each get room.
  const leaves = fields.filter((f) => !isProjection(f))
  const nested = fields.filter(isProjection)

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5",
        depth > 0 && "border-l border-border/60 pl-2.5"
      )}
    >
      <code className="font-mono text-[11px] font-medium break-all text-foreground/90">
        {head}
      </code>
      {leaves.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {leaves.map((f, j) => (
            <span
              key={j}
              className="max-w-full rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono text-[10px] break-all text-muted-foreground"
            >
              {f}
            </span>
          ))}
        </div>
      ) : null}
      {nested.map((f, j) => (
        <RestrictorNode key={j} path={f} depth={depth + 1} />
      ))}
    </div>
  )
}

function Arrow() {
  return (
    <div className="hidden items-center justify-center self-center text-muted-foreground md:flex">
      <ArrowRight className="h-4 w-4" />
    </div>
  )
}

// A column heading + subheading above its content (a JSON block or a
// status message).
function PaneHeading({
  heading,
  subheading,
  children,
}: {
  heading: string
  subheading: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-semibold">{heading}</h3>
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {subheading}
        </span>
      </div>
      {children}
    </div>
  )
}

// JSON rendered as a syntax-highlighted code block (Shiki, the same
// highlighter the chat markdown uses), themed to match light/dark.
function JsonCode({
  value,
  theme,
}: {
  value: JsonValue
  theme: "light" | "dark"
}) {
  return (
    <CodeBlock className="max-h-[70vh] overflow-auto">
      <CodeBlockCode
        code={JSON.stringify(value, null, 2)}
        language="json"
        theme={theme === "dark" ? "github-dark" : "github-light"}
      />
    </CodeBlock>
  )
}
