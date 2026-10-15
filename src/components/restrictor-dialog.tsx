import { useState } from "react"
import { ArrowDown, ArrowRight, Wrench } from "lucide-react"

import type {
  FullResponseResult,
  JsonValue,
  ToolCallInfo,
} from "@/lib/agent-types"
import { PAYLOAD_OUTPUT_META, TOOL_OUTPUT_META } from "@/lib/agent-types"
import {
  RestrictorParameter,
  RestrictorPaths,
} from "@/components/restrictor-paths"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockCode } from "@/components/ui/code-block"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { TextShimmerLoader } from "@/components/ui/loader"

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
    case "google_hotels_search":
      return `Hotels · ${a.query ?? ""}`
    case "google_shopping_search":
      return `Shopping · ${a.query ?? ""}`
    default:
      return tc.name
  }
}

// Shown here and on the breakdown card when the full responses fail to load.
export const FULL_FETCH_FAILED =
  "Couldn’t fetch the full response; ask again to retry."

export function RestrictorDialog({
  open,
  onOpenChange,
  toolCalls,
  fullResults,
  fullLoading,
  fullError,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  toolCalls: Array<ToolCallInfo>
  // Full (unrestricted) responses for the turn, aligned by index with
  // `toolCalls`. Undefined while loading or when the call fell back.
  fullResults?: Array<FullResponseResult>
  fullLoading?: boolean
  // Why fetching the full responses failed, if it did.
  fullError?: string | null
}) {
  const [activeIndex, setActiveIndex] = useState(0)
  const index =
    toolCalls.length > 0 ? Math.min(activeIndex, toolCalls.length - 1) : 0
  const call = toolCalls.length > 0 ? toolCalls[index] : null

  if (!call) return null

  const args = call.args as Record<string, string | number | boolean | null>
  const full = fullResults?.[index] ?? null
  const outputLabel = TOOL_OUTPUT_META[call.output].label
  // The full response is the same output without a restrictor.
  const fullLabel =
    PAYLOAD_OUTPUT_META[call.output === "json" ? "json-full" : "markdown-full"]
      .label

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex flex-col gap-4 sm:max-w-[min(1700px,96vw)]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Wrench className="h-4 w-4" />
            Tool call
          </DialogTitle>
          <DialogDescription className="sr-only">
            What SerpApi returned for this call and what the model received.
          </DialogDescription>
        </DialogHeader>

        {toolCalls.length > 1 ? (
          <div className="flex flex-wrap gap-1.5 border-b pb-3">
            {toolCalls.map((tc, i) => (
              <Button
                key={i}
                type="button"
                size="xs"
                variant={i === index ? "secondary" : "ghost"}
                aria-pressed={i === index}
                onClick={() => setActiveIndex(i)}
              >
                {toolCallLabel(tc)}
              </Button>
            ))}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge variant="outline" className="font-mono text-[11px]">
            {call.name}
          </Badge>
          <Badge variant="secondary" className="text-[11px]">
            {outputLabel}
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

        {call.restrictor === null ? (
          // No restrictor ("Markdown (Raw)"): the model got the full
          // response, so there is nothing to compare.
          <PaneHeading
            heading="Sent to the model"
            subheading={paneStats(call.tokens, call.serpApiMs)}
          >
            <ResponseCode value={call.response} />
          </PaneHeading>
        ) : (
          <div className="grid min-h-0 flex-1 items-start gap-3 overflow-hidden md:grid-cols-[minmax(0,1fr)_auto_minmax(0,320px)_auto_minmax(0,1fr)]">
            <PaneHeading
              heading="Full response"
              label={fullLabel}
              subheading={full ? paneStats(full.tokens, full.serpApiMs) : ""}
            >
              {full ? (
                <ResponseCode value={full.response} />
              ) : (
                <div className="flex items-center rounded-xl border bg-muted/40 p-3">
                  {fullLoading ? (
                    <TextShimmerLoader
                      text="Fetching the full response…"
                      size="sm"
                    />
                  ) : fullError ? (
                    <p
                      title={fullError}
                      className="text-[11px] leading-relaxed text-destructive"
                    >
                      {FULL_FETCH_FAILED}
                    </p>
                  ) : (
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Not measured yet. &ldquo;Compare with the full
                      response&rdquo; in the sidebar fetches it, for one more
                      SerpApi search per call.
                    </p>
                  )}
                </div>
              )}
            </PaneHeading>

            <Arrow />

            {/* The filter itself: each path SerpApi was asked to keep and
              whether this search returned it, then the literal parameter,
              then the reduction it produced. */}
            <div className="flex min-h-0 flex-col gap-3 self-stretch">
              <h3 className="text-sm font-semibold">JSON Restrictor</h3>
              <div className="-mr-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-1">
                <RestrictorPaths
                  restrictor={call.restrictor}
                  response={call.response}
                />
                <RestrictorParameter restrictor={call.restrictor} />
              </div>

              {full ? (
                <div className="flex flex-col gap-2 pt-1">
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
                      {full.tokens.toLocaleString("en-US")} →{" "}
                      {call.tokens.toLocaleString("en-US")} tokens
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <Arrow />

            <PaneHeading
              heading="Sent to the model"
              label={outputLabel}
              subheading={paneStats(call.tokens, call.serpApiMs)}
            >
              <ResponseCode value={call.response} />
            </PaneHeading>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

// Tokens and SerpApi fetch time for a pane heading.
function paneStats(tokens: number, ms: number): string {
  return `${tokens.toLocaleString("en-US")} tokens · ${(ms / 1000).toFixed(2)} s`
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
  label,
  subheading,
  children,
}: {
  heading: string
  // The output this pane shows, e.g. "Markdown (Raw)".
  label?: string
  subheading: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="flex items-baseline gap-2 text-sm font-semibold">
          {heading}
          {label ? (
            <span className="text-xs font-normal text-muted-foreground">
              {label}
            </span>
          ) : null}
        </h3>
        <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
          {subheading}
        </span>
      </div>
      {children}
    </div>
  )
}

// A SerpApi response as a syntax-highlighted code block (Shiki, the same
// highlighter the chat markdown uses). Markdown output arrives as a string
// and is shown as Markdown source; anything else is pretty-printed JSON.
function ResponseCode({ value }: { value: JsonValue }) {
  const isMarkdown = typeof value === "string"
  return (
    <CodeBlock className="max-h-[70vh] overflow-auto">
      <CodeBlockCode
        code={isMarkdown ? value : JSON.stringify(value, null, 2)}
        language={isMarkdown ? "markdown" : "json"}
      />
    </CodeBlock>
  )
}
