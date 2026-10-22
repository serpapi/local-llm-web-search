import { useEffect, useState } from "react"
import { Check, Copy, Loader2, Scale, Wrench } from "lucide-react"
import { toast } from "sonner"

import type { FullResponseResult, ToolCallInfo } from "@/lib/agent-types"
import type { MarkdownView } from "@/components/response-view"
import { PAYLOAD_OUTPUT_META, TOOL_OUTPUT_META } from "@/lib/agent-types"
import { RestrictorPaths } from "@/components/restrictor-paths"
import { KEPT_CLASS, ResponseView } from "@/components/response-view"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

// Short label per tool call, for the tabs here and the context window's
// rows. Matches the `toolCallLabel` on the server but lives here because
// the frontend doesn't import runtime from that module.
export function toolCallLabel(tc: ToolCallInfo): string {
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

// Markdown output shows as written by default, the text the model reads.
const MARKDOWN_VIEWS: Array<{ value: MarkdownView; label: string }> = [
  { value: "source", label: "Markdown" },
  { value: "preview", label: "Preview" },
]

// Shown when the full responses fail to load.
const FULL_FETCH_FAILED = "Couldn’t fetch the full response. Try again."

/**
 * Runs the turn's searches again without the restrictor, for the
 * before/after. A solid button, since it spends searches. It keeps its
 * place while it works.
 */
function CompareButton({
  searches,
  loading,
  onClick,
}: {
  searches: number
  loading: boolean
  onClick: () => void
}) {
  return (
    <Button
      type="button"
      variant="default"
      size="lg"
      onClick={onClick}
      disabled={loading}
      aria-busy={loading}
      title="Runs each search again without the restrictor."
    >
      {loading ? (
        <Loader2 data-icon="inline-start" className="animate-spin" />
      ) : (
        <Scale data-icon="inline-start" aria-hidden />
      )}
      {loading ? "Comparing…" : "Compare with the full response"}
      {loading ? null : (
        <span className="opacity-70">
          · <span className="font-mono tabular-nums">{searches}</span>{" "}
          {searches === 1 ? "search" : "searches"}
        </span>
      )}
    </Button>
  )
}

export function RestrictorDialog({
  open,
  onOpenChange,
  toolCalls,
  fullResults,
  fullLoading,
  fullError,
  onMeasure,
  activeIndex,
  onActiveIndexChange,
  onCloseAutoFocus,
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
  // Fetches the full responses, when this turn can be compared.
  onMeasure?: () => void
  // The tool call on screen, chosen by the page or the tabs here.
  activeIndex: number
  onActiveIndexChange: (index: number) => void
  // Where focus goes on close, since the page opens it without a trigger.
  onCloseAutoFocus?: (event: Event) => void
}) {
  const [view, setView] = useState<MarkdownView>("source")
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
      <DialogContent
        onCloseAutoFocus={onCloseAutoFocus}
        className="flex max-h-[94vh] flex-col gap-4 overflow-y-auto sm:max-w-[min(1700px,96vw)]"
      >
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
                onClick={() => onActiveIndexChange(i)}
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
          {typeof call.response === "string" ? (
            <div className="ml-auto flex gap-1">
              {MARKDOWN_VIEWS.map((v) => (
                <Button
                  key={v.value}
                  type="button"
                  size="xs"
                  variant={view === v.value ? "secondary" : "ghost"}
                  aria-pressed={view === v.value}
                  onClick={() => setView(v.value)}
                >
                  {v.label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>

        {call.restrictor === null ? (
          // No restrictor ("Markdown (Raw)"): the model got the full
          // response, so there is nothing to compare.
          <PaneHeading
            heading="Sent to the model"
            subheading={paneStats(call.tokens, call.serpApiMs)}
          >
            <ResponseView value={call.response} view={view} />
          </PaneHeading>
        ) : (
          <>
            {/* The filter: each path SerpApi was asked to keep, whether
                this search returned it, and what it saved. */}
            <section className="flex flex-col gap-3 rounded-xl border bg-muted/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-semibold">JSON Restrictor</h3>
                  <CopyRestrictorButton restrictor={call.restrictor} />
                </div>
                {full ? (
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">
                    <span className="text-sm font-semibold text-foreground">
                      {full.tokens > 0
                        ? Math.max(
                            0,
                            Math.round((1 - call.tokens / full.tokens) * 100)
                          )
                        : 0}
                      % smaller
                    </span>{" "}
                    · {full.tokens.toLocaleString("en-US")} →{" "}
                    {call.tokens.toLocaleString("en-US")} tokens
                  </span>
                ) : null}
              </div>
              <RestrictorPaths
                restrictor={call.restrictor}
                response={call.response}
                layout="grid"
              />
            </section>

            <div className="grid items-start gap-4 md:grid-cols-2">
              <PaneHeading
                heading="Full response"
                label={fullLabel}
                subheading={full ? paneStats(full.tokens, full.serpApiMs) : ""}
                legend={full ? "Kept by the restrictor" : undefined}
              >
                {full ? (
                  <ResponseView
                    value={full.response}
                    keptIn={call.response}
                    view={view}
                  />
                ) : (
                  <div className="flex min-h-40 flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/40 p-6 text-center">
                    {onMeasure ? (
                      <CompareButton
                        searches={toolCalls.length}
                        loading={fullLoading ?? false}
                        onClick={onMeasure}
                      />
                    ) : (
                      <p className="text-[11px] text-muted-foreground">
                        This call can&rsquo;t be compared with its full
                        response.
                      </p>
                    )}
                    {fullError ? (
                      <p
                        title={fullError}
                        className="text-[11px] text-destructive"
                      >
                        {FULL_FETCH_FAILED}
                      </p>
                    ) : null}
                  </div>
                )}
              </PaneHeading>

              <PaneHeading
                heading="Sent to the model"
                label={outputLabel}
                subheading={paneStats(call.tokens, call.serpApiMs)}
              >
                <ResponseView value={call.response} view={view} />
              </PaneHeading>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

// Tokens and SerpApi fetch time for a pane heading.
function paneStats(tokens: number, ms: number): string {
  return `${tokens.toLocaleString("en-US")} tokens · ${(ms / 1000).toFixed(2)} s`
}

// Copies the literal `json_restrictor` value this call sent to SerpApi.
function CopyRestrictorButton({ restrictor }: { restrictor: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2000)
    return () => clearTimeout(timer)
  }, [copied])
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="text-muted-foreground"
      onClick={() => {
        navigator.clipboard.writeText(restrictor).then(
          () => setCopied(true),
          () => toast.error("Could not copy the json_restrictor.")
        )
      }}
    >
      {copied ? (
        <Check data-icon="inline-start" />
      ) : (
        <Copy data-icon="inline-start" />
      )}
      {copied ? "Copied" : "Copy json_restrictor"}
    </Button>
  )
}

// A pane heading and stats above its content (a response or a status
// message). `legend` names what the highlight in the response means.
function PaneHeading({
  heading,
  label,
  subheading,
  legend,
  children,
}: {
  heading: string
  // The output this pane shows, e.g. "Markdown (Raw)".
  label?: string
  subheading: string
  legend?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="flex items-baseline gap-2 text-sm font-semibold">
          {heading}
          {label ? (
            <span className="text-xs font-normal text-muted-foreground">
              {label}
            </span>
          ) : null}
        </h3>
        <span className="flex items-baseline gap-3 font-mono text-[11px] text-muted-foreground tabular-nums">
          {legend ? (
            <mark className={`${KEPT_CLASS} px-1 font-sans`}>{legend}</mark>
          ) : null}
          {subheading}
        </span>
      </div>
      {children}
    </div>
  )
}
