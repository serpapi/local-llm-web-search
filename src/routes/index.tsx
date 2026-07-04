import { createFileRoute } from "@tanstack/react-router"
import {
  AlertTriangle,
  ArrowUpRight,
  Braces,
  CheckCircle2,
  Eraser,
  FlaskConical,
  Loader2,
  Moon,
  Send,
  Sparkles,
  Sun,
  Wrench,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import type {
  Breakdown,
  ExactUsage,
  FullResponseResult,
  ModelInfo,
  Phases,
  QueryProgress,
  Source,
  ToolCallInfo,
} from "@/server/agent"
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
import {
  ChatContainerContent,
  ChatContainerRoot,
  ChatContainerScrollAnchor,
} from "@/components/ui/chat-container"
import { TextShimmerLoader } from "@/components/ui/loader"
import { Message, MessageContent } from "@/components/ui/message"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { RestrictorDialog } from "@/components/restrictor-dialog"
import {
  PromptInput,
  PromptInputAction,
  PromptInputActions,
  PromptInputTextarea,
} from "@/components/ui/prompt-input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  CONTEXT_SEGMENTS,
  contextTotal,
  fetchFullResponse,
  getQueryProgress,
  listModels,
  runQuery,
} from "@/server/agent"

export const Route = createFileRoute("/")({
  head: () => ({ meta: [{ title: "SerpApi + Local LLM" }] }),
  component: App,
})

const THEME_STORAGE_KEY = "local-llm-web-search:theme"

// Default model preference: exact qwen3.5-9b > any Qwen > any tool-use
// trained model > first available.
function pickDefaultModel(models: Array<ModelInfo>): ModelInfo | null {
  if (models.length === 0) return null
  const qwen95 = models.find((m) => /qwen.*3\.?5.*9b/i.test(m.id))
  if (qwen95) return qwen95
  const anyQwen = models.find((m) => /qwen/i.test(m.id))
  if (anyQwen) return anyQwen
  const trained = models.find((m) => m.toolUseTrained)
  if (trained) return trained
  return models[0] ?? null
}

type ChatMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  toolCalls?: Array<ToolCallInfo>
  sources?: Array<Source>
  elapsedMs?: number
  phases?: Phases
  isError?: boolean
}

// Captured per query: how big was the model's usable context at the moment
// it ran, so the sidebar can show "tokens used / budget loaded" even after
// the user changes model in the dropdown.
type ModelContextSnapshot = {
  loaded: number // the context LM Studio ACTUALLY loaded this turn (after the server's back-off probe), falling back to the requested size if no load was confirmed
  max: number // maxContextLength — the model's theoretical ceiling
}

// Loose shape for the conversation history we ship back to the server.
// We mirror the OpenAI Chat Completions message shape without depending
// on the OpenAI SDK types on the client — the server validates it with
// Zod anyway, so a structural type is enough.
type ConversationMessage = {
  role: string
  content?: string | null
  tool_calls?: Array<unknown>
  tool_call_id?: string
  name?: string
}

// Colors assigned per context segment. Brand tones for the meaningful movers
// (tool definitions, tool result, final response); neutrals for overhead
// (system prompt, user message, tool call). Keeps the stacked bar readable
// while telling the story visually: "where does the budget actually go?"
const SEGMENT_COLORS: Record<keyof Breakdown, string> = {
  tool_definitions: "bg-serpapi-blue",
  system_prompt: "bg-slate-400 dark:bg-slate-500",
  conversation_history: "bg-indigo-400 dark:bg-indigo-500",
  user_message: "bg-slate-300 dark:bg-slate-600",
  tool_call: "bg-amber-400",
  tool_result: "bg-serpapi-purple",
  final_response: "bg-serpapi-violet",
}

// Example questions — one per SerpApi engine plus offline / direct-answer
// prompts. Shown in a popover next to the Send button so the chat area
// stays clean.
type ExampleQuestion = {
  label: string
  question: string
}

type ExampleGroup = {
  title: string
  description: string
  items: Array<ExampleQuestion>
}

// A flight date ~2 months out, computed when the examples are built so
// the Flights example never points at a past date as the app ages.
function exampleFlightDate(): string {
  const d = new Date()
  d.setMonth(d.getMonth() + 2)
  return d.toISOString().slice(0, 10)
}

// A 3-night hotel stay on the same horizon as the flight example, so the
// trip-planning example reads as one coherent itinerary.
function exampleHotelDates(): { checkIn: string; checkOut: string } {
  const checkIn = new Date()
  checkIn.setMonth(checkIn.getMonth() + 2)
  const checkOut = new Date(checkIn)
  checkOut.setDate(checkOut.getDate() + 3)
  return {
    checkIn: checkIn.toISOString().slice(0, 10),
    checkOut: checkOut.toISOString().slice(0, 10),
  }
}

function buildExamples(): Array<ExampleGroup> {
  return [
    {
      title: "Live data",
      description: "One question per SerpApi engine.",
      items: [
        {
          label: "Search",
          question: "Who is the current CEO of Perplexity?",
        },
        {
          label: "Finance",
          question: "What's the current price of NVDA?",
        },
        {
          label: "News",
          question: "Top headlines about the EU AI Act this week",
        },
        {
          label: "Maps",
          question: "Best barbecue restaurants in Austin, Texas",
        },
        {
          label: "Flights",
          question: `Flights from JFK to LAX on ${exampleFlightDate()}`,
        },
        {
          label: "Hotels",
          question: `Hotels in Barcelona from ${exampleHotelDates().checkIn} to ${exampleHotelDates().checkOut} for 2 adults`,
        },
        {
          label: "Shopping",
          question: "Best price for AirPods Pro 3",
        },
      ],
    },
    {
      title: "No tools",
      description: "Model answers on its own, no API calls.",
      items: [
        { label: "Arithmetic", question: "What is 2+2?" },
        { label: "Percentage", question: "What is 15% of 240?" },
        { label: "Creative", question: "Write a haiku about API tokens" },
        {
          label: "Translation",
          question: 'Translate "thank you" to Japanese',
        },
      ],
    },
    {
      title: "Edge case",
      description: "Parallel tool calls: multiple engines in one turn.",
      items: [
        {
          label: "Multi-entity",
          question: "Compare the current prices of AAPL and TSLA",
        },
        {
          label: "Trip planning",
          question: `Find flights from JFK to BCN on ${exampleHotelDates().checkIn} and hotels in Barcelona from ${exampleHotelDates().checkIn} to ${exampleHotelDates().checkOut}`,
        },
      ],
    },
  ]
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID()
  }
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// A Finance call that found no quote falls back to google_search, so its
// response no longer matches what an unrestricted Finance call would
// return — comparing the two would be apples-to-oranges, so we skip the
// before/after for it.
function isFallbackResponse(call: ToolCallInfo): boolean {
  return (
    call.response != null &&
    typeof call.response === "object" &&
    !Array.isArray(call.response) &&
    "fallback_from" in call.response
  )
}

// The full (unrestricted) SerpApi responses for the latest turn, fetched
// once and shared by the breakdown card and the inspect dialog. `results`
// is aligned by index with the turn's tool calls.
type FullFetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error" }
  | { status: "done"; results: Array<FullResponseResult> }

function App() {
  const [messages, setMessages] = useState<Array<ChatMessage>>([])
  const [breakdown, setBreakdown] = useState<Breakdown | null>(null)
  const [exactUsage, setExactUsage] = useState<ExactUsage | null>(null)
  const [latestPhases, setLatestPhases] = useState<Phases | null>(null)
  // Snapshot of the model's context limits at query time. Shown next to
  // the tokens used so readers see "we spent 911 out of 32,768 available."
  const [latestModelContext, setLatestModelContext] =
    useState<ModelContextSnapshot | null>(null)
  // Full conversation in OpenAI format — every turn's user message,
  // assistant message(s), and tool result(s). This is what the model sees
  // as "memory". Clear chat resets to []. See the comment on
  // `RunQueryResult.messages` in agent.ts for why this is the canonical
  // multi-turn pattern.
  const [conversationMessages, setConversationMessages] = useState<
    Array<ConversationMessage>
  >([])
  // Number of old turns the server had to drop from the last request to
  // stay under the context budget. Surfaces a one-line hint in the UI.
  const [trimmedTurns, setTrimmedTurns] = useState(0)
  // Cumulative conversation size (tool defs + system + sanitized history)
  // returned by the server after each turn. Drives the "Context used" hero
  // — grows monotonically like LM Studio's counter until the sliding window
  // trims.
  const [conversationTokens, setConversationTokens] = useState(0)
  // Latest tool call details (name, args, raw + formatted responses) —
  // powers the "Raw vs formatted" dialog. Empty when the last turn was
  // a direct answer with no tool call.
  const [latestToolCalls, setLatestToolCalls] = useState<Array<ToolCallInfo>>(
    []
  )
  // Auto-fetch the full (unrestricted) responses for the latest turn so the
  // card can show the before/after and the dialog can show the raw JSON —
  // one fetch per turn, shared by both.
  const [fullFetch, setFullFetch] = useState<FullFetchState>({ status: "idle" })
  const toolCallKey = latestToolCalls
    .map((c) => `${c.name}:${JSON.stringify(c.args)}`)
    .join("|")

  useEffect(() => {
    if (
      latestToolCalls.length === 0 ||
      latestToolCalls.some(isFallbackResponse)
    ) {
      setFullFetch({ status: "idle" })
      return
    }
    let cancelled = false
    setFullFetch({ status: "loading" })
    Promise.all(
      latestToolCalls.map((c) =>
        fetchFullResponse({ data: { name: c.name, args: c.args } })
      )
    )
      .then((results) => {
        if (!cancelled) setFullFetch({ status: "done", results })
      })
      .catch(() => {
        if (!cancelled) setFullFetch({ status: "error" })
      })
    return () => {
      cancelled = true
    }
  }, [toolCallKey])

  const [rawFormattedOpen, setRawFormattedOpen] = useState(false)
  const [input, setInput] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  // Live stage of the in-flight query, polled from the server so the chat
  // can show real progress instead of a silent spinner.
  const [liveProgress, setLiveProgress] = useState<QueryProgress | null>(null)
  const [availableModels, setAvailableModels] =
    useState<Array<ModelInfo> | null>(null)
  const [selectedModel, setSelectedModel] = useState<ModelInfo | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [theme, setTheme] = useState<"light" | "dark">("light")

  useEffect(() => {
    let cancelled = false
    listModels()
      .then((models) => {
        if (cancelled) return
        setAvailableModels(models)
        setSelectedModel(pickDefaultModel(models))
      })
      .catch((err) => {
        if (cancelled) return
        setModelsError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (typeof window === "undefined") return
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    const prefersDark = window.matchMedia(
      "(prefers-color-scheme: dark)"
    ).matches
    const initial: "light" | "dark" =
      stored === "dark" || stored === "light"
        ? stored
        : prefersDark
          ? "dark"
          : "light"
    setTheme(initial)
    document.documentElement.classList.toggle("dark", initial === "dark")
  }, [])

  function toggleTheme() {
    setTheme((current) => {
      const next = current === "dark" ? "light" : "dark"
      document.documentElement.classList.toggle("dark", next === "dark")
      if (typeof window !== "undefined") {
        window.localStorage.setItem(THEME_STORAGE_KEY, next)
      }
      return next
    })
  }

  const canSubmit = Boolean(selectedModel) && !modelsError

  async function submit() {
    const question = input.trim()
    if (!question || isLoading || !selectedModel) return

    const userMessage: ChatMessage = {
      id: newId(),
      role: "user",
      content: question,
    }
    setMessages((m) => [...m, userMessage])
    setInput("")
    setIsLoading(true)
    const start = performance.now()

    // Poll the server's stage marker while the call is in flight (see
    // `getQueryProgress` in agent.ts). Best-effort: a failed poll just
    // leaves the previous stage on screen.
    const progressId = newId()
    setLiveProgress({ stage: "load", detail: null })
    const progressPoll = setInterval(() => {
      getQueryProgress({ data: { id: progressId } })
        .then((p) => {
          if (p) setLiveProgress(p)
        })
        .catch(() => {
          // Ignore poll failures — progress display is cosmetic.
        })
    }, 500)

    // Client-side watchdog. The server has its own timeouts (60s per
    // completion × up to 3 completions + tool exec), so total worst case
    // is ~3 min. If the RPC hangs past that (e.g. Vite HMR interrupts an
    // in-flight request during dev), surface a friendly error instead of
    // leaving the spinner up forever.
    const CLIENT_WATCHDOG_MS = 180_000
    const timeoutSentinel = Symbol("client-watchdog-timeout")
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const watchdog = new Promise<typeof timeoutSentinel>((resolve) => {
      timeoutHandle = setTimeout(
        () => resolve(timeoutSentinel),
        CLIENT_WATCHDOG_MS
      )
    })

    try {
      const raced = await Promise.race([
        runQuery({
          data: {
            question,
            model: selectedModel.id,
            contextLength: selectedModel.recommendedContextLength,
            toolUseTrained: selectedModel.toolUseTrained,
            history: conversationMessages,
            progressId,
          },
        }),
        watchdog,
      ])

      if (raced === timeoutSentinel) {
        throw new Error(
          "Request timed out after 3 minutes on the client. The server may still be running; try again, or pick a smaller/faster model."
        )
      }

      const result = raced
      setMessages((m) => [
        ...m,
        {
          id: newId(),
          role: "assistant",
          content: result.answer,
          // WHY: on a failed turn `toolCalls` is an empty array, which
          //      would render a misleading "Direct answer" badge under
          //      the error text — omit the panel entirely instead.
          toolCalls: result.ok ? result.toolCalls : undefined,
          sources: result.sources,
          elapsedMs: result.elapsedMs,
          phases: result.phases,
        },
      ])
      // WHY: a failed turn resolves (not rejects) with `ok: false` and
      //      all-zero metrics, while the conversation itself is unchanged.
      //      Overwriting the sidebar with those zeros would make it look
      //      like the context was wiped when it wasn't — keep the last
      //      real turn's numbers instead.
      if (result.ok) {
        setBreakdown(result.breakdown)
        setExactUsage(result.exactUsage)
        setLatestPhases(result.phases)
        setLatestModelContext({
          // WHY: the server's load probe may have backed the context off to
          //      fit this machine, so trust the size it reports actually
          //      loaded. Fall back to the requested size only when the server
          //      couldn't confirm a load (e.g. LM Studio unreachable).
          loaded:
            result.loadedContext ?? selectedModel.recommendedContextLength,
          max: selectedModel.maxContextLength,
        })
        setTrimmedTurns(result.trimmedTurns)
        setConversationTokens(result.conversationTokens)
        setLatestToolCalls(result.toolCalls)
      }
      // Replace with the server's authoritative history (includes the new
      // user turn, tool calls/results, and the assistant answer — already
      // trimmed if needed; unchanged on a failed turn). Next submit sends
      // this back verbatim.
      setConversationMessages(result.messages as Array<ConversationMessage>)
    } catch (err) {
      const errorText = `**Error:** ${
        err instanceof Error ? err.message : String(err)
      }`
      setMessages((m) => [
        ...m,
        {
          id: newId(),
          role: "assistant",
          content: errorText,
          toolCalls: [],
          sources: [],
          elapsedMs: Math.round(performance.now() - start),
          isError: true,
        },
      ])
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle)
      clearInterval(progressPoll)
      setLiveProgress(null)
      setIsLoading(false)
    }
  }

  function clearChat() {
    setMessages([])
    setBreakdown(null)
    setExactUsage(null)
    setLatestPhases(null)
    setLatestModelContext(null)
    setConversationMessages([])
    setTrimmedTurns(0)
    setConversationTokens(0)
    setLatestToolCalls([])
    setRawFormattedOpen(false)
  }

  return (
    <div className="flex min-h-svh flex-col bg-muted/40 lg:h-svh lg:overflow-hidden">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6 lg:min-h-0 lg:flex-1 lg:overflow-hidden">
        <Header
          availableModels={availableModels}
          selectedModel={selectedModel}
          onSelectModel={(id) => {
            const match = availableModels?.find((m) => m.id === id)
            if (match) setSelectedModel(match)
          }}
          modelsError={modelsError}
          theme={theme}
          onToggleTheme={toggleTheme}
        />
        <RestrictorDialog
          open={rawFormattedOpen}
          onOpenChange={setRawFormattedOpen}
          toolCalls={latestToolCalls}
          fullResults={
            fullFetch.status === "done" ? fullFetch.results : undefined
          }
          fullLoading={fullFetch.status === "loading"}
          theme={theme}
        />
        <div className="grid gap-6 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_380px] lg:overflow-hidden">
          <ChatPanel
            messages={messages}
            input={input}
            setInput={setInput}
            isLoading={isLoading}
            progress={liveProgress}
            onSubmit={submit}
            onClear={clearChat}
            canSubmit={canSubmit}
            turnsInMemory={
              conversationMessages.filter((m) => m.role === "user").length
            }
            trimmedTurns={trimmedTurns}
          />
          <BreakdownPanel
            breakdown={breakdown}
            exactUsage={exactUsage}
            phases={latestPhases}
            modelContext={latestModelContext}
            conversationTokens={conversationTokens}
            toolCalls={latestToolCalls}
            fullFetch={fullFetch}
            onInspectRaw={
              latestToolCalls.length > 0
                ? () => setRawFormattedOpen(true)
                : undefined
            }
          />
        </div>
      </div>
    </div>
  )
}

function Header({
  availableModels,
  selectedModel,
  onSelectModel,
  modelsError,
  theme,
  onToggleTheme,
}: {
  availableModels: Array<ModelInfo> | null
  selectedModel: ModelInfo | null
  onSelectModel: (id: string) => void
  modelsError: string | null
  theme: "light" | "dark"
  onToggleTheme: () => void
}) {
  return (
    <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-center gap-3">
        <img
          src="/serpapi-logo.svg"
          alt="SerpApi"
          className="h-10 w-10 shrink-0 rounded-xl shadow-sm"
        />
        <div className="flex flex-col">
          <h1 className="text-2xl font-semibold tracking-tight">
            <span className="serpapi-gradient bg-clip-text text-transparent">
              SerpApi
            </span>{" "}
            + Local LLM
          </h1>
          <p className="text-sm text-muted-foreground">
            Local inference by{" "}
            <span className="font-medium text-foreground">LM Studio</span>. Live
            web data by{" "}
            <span className="font-medium text-foreground">SerpApi</span>.
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <ModelSelector
          availableModels={availableModels}
          selectedModel={selectedModel}
          onSelectModel={onSelectModel}
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
          className="shrink-0"
        >
          {theme === "dark" ? (
            <Sun className="h-4 w-4" />
          ) : (
            <Moon className="h-4 w-4" />
          )}
        </Button>
      </div>
    </header>
  )
}

function ModelSelector({
  availableModels,
  selectedModel,
  onSelectModel,
  modelsError,
}: {
  availableModels: Array<ModelInfo> | null
  selectedModel: ModelInfo | null
  onSelectModel: (id: string) => void
  modelsError: string | null
}) {
  if (modelsError !== null) {
    return (
      <div
        role="alert"
        className="flex h-9 items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 text-xs text-destructive"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        <span className="font-medium">LM Studio unreachable</span>
      </div>
    )
  }

  if (availableModels === null) {
    return (
      <div className="flex h-9 items-center px-3 text-xs text-muted-foreground">
        Loading models…
      </div>
    )
  }

  if (availableModels.length === 0) {
    return (
      <div className="flex h-9 items-center gap-2 rounded-lg border px-3 text-xs">
        <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
        <span className="font-medium">No models loaded</span>
      </div>
    )
  }

  return (
    <Select
      value={selectedModel?.id ?? undefined}
      onValueChange={onSelectModel}
    >
      <SelectTrigger className="min-w-[240px]" aria-label="Select model">
        <SelectValue placeholder="Pick a model" />
      </SelectTrigger>
      <SelectContent>
        {availableModels.map((m) => (
          <SelectItem key={m.id} value={m.id} className="py-2">
            <ModelSelectRow model={m} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// Single-line compact display. Fits the default shadcn trigger height (h-9)
// cleanly and reads well in the dropdown too. The params/arch/ctx detail is
// moved into a muted suffix rather than a second row, which was pushing the
// trigger off-balance with the inline dark-mode toggle.
function ModelSelectRow({ model }: { model: ModelInfo }) {
  const meta: Array<string> = []
  if (model.params) meta.push(model.params)
  if (model.arch) meta.push(model.arch)
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="truncate font-mono text-sm">{model.id}</span>
      {meta.length > 0 ? (
        <span className="hidden shrink-0 font-mono text-[11px] text-muted-foreground sm:inline">
          {meta.join(" · ")}
        </span>
      ) : null}
      {model.toolUseTrained ? (
        <CheckCircle2
          aria-label="Trained for tool use"
          className="h-3.5 w-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
        />
      ) : (
        <AlertTriangle
          aria-label="Not flagged for tool use"
          className="h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400"
        />
      )}
    </div>
  )
}

function ExamplesPopover({
  onPick,
  disabled,
}: {
  onPick: (q: string) => void
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  // Built once per mount so the Flights example's date is current.
  const examples = useMemo(() => buildExamples(), [])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          className="h-9 gap-1.5 rounded-full text-xs"
          aria-label="Open examples"
        >
          <FlaskConical className="h-3.5 w-3.5" />
          Examples
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        className="w-[340px] p-3"
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-0.5 px-1">
            <span className="text-sm font-semibold">Examples</span>
            <span className="text-xs text-muted-foreground">
              Click a question to fill the input.
            </span>
          </div>
          <div className="flex flex-col gap-3">
            {examples.map((group) => (
              <div key={group.title} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between px-1">
                  <span className="text-[11px] font-semibold tracking-wide uppercase">
                    {group.title}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {group.description}
                  </span>
                </div>
                <ul className="flex flex-col gap-1">
                  {group.items.map((q) => (
                    <li key={q.question}>
                      <button
                        type="button"
                        onClick={() => {
                          onPick(q.question)
                          setOpen(false)
                        }}
                        className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted"
                      >
                        <Badge
                          variant="outline"
                          className="shrink-0 font-mono text-[10px]"
                        >
                          {q.label}
                        </Badge>
                        <span className="flex-1 truncate text-foreground">
                          {q.question}
                        </span>
                        <ArrowUpRight className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function ChatPanel({
  messages,
  input,
  setInput,
  isLoading,
  progress,
  onSubmit,
  onClear,
  canSubmit,
  turnsInMemory,
  trimmedTurns,
}: {
  messages: Array<ChatMessage>
  input: string
  setInput: (v: string) => void
  isLoading: boolean
  progress: QueryProgress | null
  onSubmit: () => void
  onClear: () => void
  canSubmit: boolean
  turnsInMemory: number
  trimmedTurns: number
}) {
  const disabled = isLoading || !canSubmit
  const description =
    turnsInMemory === 0
      ? "Ask anything that needs real-world data, or pick a benchmark below."
      : `${turnsInMemory} turn${turnsInMemory === 1 ? "" : "s"} in memory${
          trimmedTurns > 0
            ? ` · ${trimmedTurns} older turn${trimmedTurns === 1 ? "" : "s"} dropped to fit`
            : ""
        }`
  return (
    <Card className="flex min-h-[70svh] flex-col gap-0 overflow-hidden py-0 lg:h-full lg:min-h-0">
      <CardHeader className="shrink-0 border-b py-4">
        <CardTitle>Chat</CardTitle>
        <CardDescription>{description}</CardDescription>
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            disabled={isLoading || messages.length === 0}
            className="h-8 gap-1.5 rounded-full text-xs text-muted-foreground hover:text-foreground"
          >
            <Eraser className="h-3.5 w-3.5" />
            Clear chat
          </Button>
        </CardAction>
      </CardHeader>

      <ChatContainerRoot
        className="min-h-0 flex-1 px-4 py-4"
        aria-live="polite"
        aria-label="Chat messages"
      >
        <ChatContainerContent className="gap-4">
          {messages.length === 0 ? (
            <EmptyChatState />
          ) : (
            messages.map((m) => <ChatMessageBubble key={m.id} message={m} />)
          )}
          {isLoading ? <QueryProgressLadder progress={progress} /> : null}
          <ChatContainerScrollAnchor />
        </ChatContainerContent>
      </ChatContainerRoot>

      <div className="shrink-0 border-t p-4">
        <PromptInput
          value={input}
          onValueChange={setInput}
          onSubmit={onSubmit}
          isLoading={isLoading}
          disabled={disabled}
          className="shadow-none"
        >
          <PromptInputTextarea
            aria-label="Chat input"
            placeholder={
              canSubmit
                ? "Ask anything that needs real-world data..."
                : "Load a model in LM Studio to start..."
            }
          />
          <PromptInputActions className="justify-between gap-2 pt-2">
            <ExamplesPopover onPick={setInput} disabled={disabled} />
            <PromptInputAction
              tooltip={isLoading ? "Waiting for the model…" : "Send"}
            >
              <Button
                type="button"
                size="sm"
                onClick={onSubmit}
                disabled={disabled || !input.trim()}
                aria-label="Send message"
                className="h-9 rounded-full serpapi-gradient px-4 text-white shadow-sm hover:opacity-90 disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
                <span className="sr-only">Send</span>
              </Button>
            </PromptInputAction>
          </PromptInputActions>
        </PromptInput>
      </div>
    </Card>
  )
}

function EmptyChatState() {
  return (
    <div className="flex flex-1 animate-in flex-col items-center justify-center gap-2 px-4 py-12 text-center duration-500 fade-in">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
        <Sparkles className="h-5 w-5 text-serpapi-blue" />
      </div>
      <p className="text-sm font-medium text-foreground">Ready when you are.</p>
      <p className="max-w-xs text-xs leading-relaxed text-muted-foreground">
        Type a question, or tap{" "}
        <span className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
          Examples
        </span>{" "}
        below to try all seven SerpApi engines.
      </p>
    </div>
  )
}

// The stages a query moves through server-side, in order. The ladder
// renders like a small activity log: finished stages collapse to a check,
// the live stage shimmers, and stages that never happen (no tool call)
// simply never appear.
const PROGRESS_STAGES: Array<{ key: QueryProgress["stage"]; label: string }> = [
  { key: "load", label: "Loading the model" },
  { key: "think", label: "Thinking" },
  { key: "tools", label: "Calling SerpApi" },
  { key: "answer", label: "Writing the answer" },
]

function QueryProgressLadder({ progress }: { progress: QueryProgress | null }) {
  const activeIdx = Math.max(
    0,
    PROGRESS_STAGES.findIndex((s) => s.key === (progress?.stage ?? "load"))
  )
  return (
    <div
      className="flex flex-col gap-2 pl-1"
      role="status"
      aria-label="Query progress"
    >
      {PROGRESS_STAGES.map((s, i) => {
        if (i > activeIdx) return null
        const active = i === activeIdx
        const label =
          s.key === "tools" && progress?.detail
            ? `${s.label} · ${progress.detail}`
            : s.label
        return (
          <div
            key={s.key}
            className="flex animate-in items-center gap-2 text-muted-foreground duration-300 fade-in slide-in-from-bottom-1"
          >
            {active ? (
              <Loader2
                aria-hidden
                className="h-3.5 w-3.5 shrink-0 animate-spin"
              />
            ) : (
              <CheckCircle2
                aria-hidden
                className="h-3.5 w-3.5 shrink-0 text-serpapi-blue"
              />
            )}
            {active ? (
              <TextShimmerLoader text={`${label}…`} size="sm" />
            ) : (
              <span className="text-xs">{label}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

function ChatMessageBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user"

  if (isUser) {
    return (
      <Message
        className="animate-in justify-end duration-300 fade-in slide-in-from-bottom-2"
        role="article"
        aria-label="Your message"
      >
        <MessageContent className="max-w-[85%] rounded-2xl serpapi-gradient text-sm text-white [&_*]:text-white">
          {message.content}
        </MessageContent>
      </Message>
    )
  }

  const hasMetadata =
    message.toolCalls !== undefined ||
    (message.sources && message.sources.length > 0) ||
    typeof message.elapsedMs === "number"

  return (
    <Message
      className="animate-in justify-start duration-300 fade-in slide-in-from-bottom-2"
      role={message.isError ? "alert" : "article"}
      aria-label={message.isError ? "Error response" : "Assistant response"}
    >
      <div
        className={
          message.isError
            ? "flex max-w-[85%] flex-col overflow-hidden rounded-2xl border border-destructive/40 bg-destructive/5 shadow-sm"
            : "flex max-w-[85%] flex-col overflow-hidden rounded-2xl border border-border/60 bg-muted/60 shadow-sm"
        }
      >
        <MessageContent
          markdown
          className="rounded-none bg-transparent p-4 text-sm text-foreground"
        >
          {message.content}
        </MessageContent>
        {hasMetadata ? (
          <div className="flex flex-col gap-3 border-t border-border/50 bg-background/60 px-4 py-3">
            {message.toolCalls !== undefined ? (
              <ToolCallsPanel toolCalls={message.toolCalls} />
            ) : null}
            {message.sources && message.sources.length > 0 ? (
              <SourcesList sources={message.sources} />
            ) : null}
            {typeof message.elapsedMs === "number" ? (
              <div className="text-right font-mono text-xs text-muted-foreground tabular-nums">
                {(message.elapsedMs / 1000).toFixed(2)}s
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </Message>
  )
}

function ToolCallsPanel({ toolCalls }: { toolCalls: Array<ToolCallInfo> }) {
  if (toolCalls.length === 0) {
    return (
      <Badge
        variant="outline"
        className="w-fit gap-1 font-mono text-xs text-muted-foreground"
      >
        <Sparkles className="h-3 w-3" />
        Direct answer
      </Badge>
    )
  }
  const heading =
    toolCalls.length === 1 ? null : (
      <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {toolCalls.length} parallel tool calls
      </span>
    )
  return (
    <div className="flex flex-col gap-2">
      {heading}
      {toolCalls.map((call, i) => (
        <ToolBadge key={`${call.name}-${i}`} toolCall={call} />
      ))}
    </div>
  )
}

function ToolBadge({ toolCall }: { toolCall: ToolCallInfo }) {
  const entries = Object.entries(toolCall.args)
  return (
    <div className="flex flex-col gap-1">
      <Badge className="w-fit gap-1 border-0 serpapi-gradient font-mono text-xs text-white">
        <Wrench className="h-3 w-3" />
        {toolCall.name}
      </Badge>
      {entries.length > 0 ? (
        <ul className="flex flex-col gap-0.5 pl-4 font-mono text-xs text-muted-foreground">
          {entries.map(([k, v]) => (
            <li key={k}>
              <span className="font-medium">{k}:</span>{" "}
              <span className="break-all">{JSON.stringify(v)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function SourcesList({ sources }: { sources: Array<Source> }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        Sources
      </span>
      <ul className="flex flex-wrap gap-1.5">
        {sources.map((s) => {
          const isSerpApi = s.label.startsWith("SerpApi")
          return (
            <li key={s.url} className="min-w-0">
              <a
                href={s.url}
                target="_blank"
                rel="noreferrer noopener"
                className="group inline-flex max-w-72 items-center gap-1.5 rounded-full border border-border/60 bg-background px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground"
              >
                <span
                  aria-hidden
                  className={
                    isSerpApi
                      ? "inline-block h-2 w-2 shrink-0 rounded-full serpapi-gradient"
                      : "inline-block h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40"
                  }
                />
                <span className="truncate">{s.label}</span>
                <ArrowUpRight className="h-3 w-3 shrink-0 opacity-40 transition-opacity group-hover:opacity-100" />
              </a>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function BreakdownPanel({
  breakdown,
  exactUsage,
  phases,
  modelContext,
  conversationTokens,
  toolCalls,
  fullFetch,
  onInspectRaw,
}: {
  breakdown: Breakdown | null
  exactUsage: ExactUsage | null
  phases: Phases | null
  modelContext: ModelContextSnapshot | null
  conversationTokens: number
  toolCalls: Array<ToolCallInfo>
  fullFetch: FullFetchState
  onInspectRaw?: () => void
}) {
  return (
    <Card className="flex flex-col lg:h-full lg:min-h-0">
      <CardHeader className="shrink-0 pb-3">
        <CardTitle>Token breakdown</CardTitle>
        <CardDescription>
          How full the model's context is right now, with the split per segment
          and per-phase latency for the latest turn.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {breakdown === null ? (
          <EmptyBreakdown />
        ) : (
          <BreakdownBody
            breakdown={breakdown}
            exactUsage={exactUsage}
            phases={phases}
            modelContext={modelContext}
            conversationTokens={conversationTokens}
            toolCalls={toolCalls}
            fullFetch={fullFetch}
            onInspectRaw={onInspectRaw}
          />
        )}
      </CardContent>
    </Card>
  )
}

function EmptyBreakdown() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 py-12 text-center text-sm text-muted-foreground">
      <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
        <Sparkles className="h-4 w-4" />
      </div>
      <p>Ask a question to see the breakdown.</p>
    </div>
  )
}

function BreakdownBody({
  breakdown,
  exactUsage,
  phases,
  modelContext,
  conversationTokens,
  toolCalls,
  fullFetch,
  onInspectRaw,
}: {
  breakdown: Breakdown
  exactUsage: ExactUsage | null
  phases: Phases | null
  modelContext: ModelContextSnapshot | null
  conversationTokens: number
  toolCalls: Array<ToolCallInfo>
  fullFetch: FullFetchState
  onInspectRaw?: () => void
}) {
  const estimate = contextTotal(breakdown)

  // Rank segments by size so the compact list leads with the biggest movers.
  const orderedSegments = [...CONTEXT_SEGMENTS]
    .map((seg) => ({
      ...seg,
      count: breakdown[seg.key],
      pct: estimate > 0 ? breakdown[seg.key] / estimate : 0,
      color: SEGMENT_COLORS[seg.key],
    }))
    .sort((a, b) => b.count - a.count)

  return (
    <div className="flex flex-col gap-5">
      <HeroTotal
        conversationTokens={conversationTokens}
        lastTurnTotal={estimate}
        exactUsage={exactUsage}
        modelContext={modelContext}
      />
      <StackedBar segments={orderedSegments} total={estimate} />
      <SegmentList segments={orderedSegments} />
      {breakdown.tool_result > 0 ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Tool call and result tokens are sent to the model this turn, then
          dropped from conversation memory. That is why the segments above can
          add up to more than “Context used”.
        </p>
      ) : null}
      {phases ? (
        <LatencyCard
          phases={phases}
          completionTokens={exactUsage?.completionTokens ?? null}
        />
      ) : null}
      {toolCalls.length > 0 ? (
        <JsonRestrictorCard
          toolCalls={toolCalls}
          fullFetch={fullFetch}
          onInspect={onInspectRaw}
        />
      ) : null}
    </div>
  )
}

function HeroTotal({
  conversationTokens,
  lastTurnTotal,
  exactUsage,
  modelContext,
}: {
  conversationTokens: number
  lastTurnTotal: number
  exactUsage: ExactUsage | null
  modelContext: ModelContextSnapshot | null
}) {
  const budget = modelContext?.loaded ?? null
  const pctUsed = budget && budget > 0 ? (conversationTokens / budget) * 100 : 0
  const pctLabel =
    budget && pctUsed > 0 && pctUsed < 1 ? "<1%" : `${Math.round(pctUsed)}%`
  const maxLabel =
    modelContext && modelContext.max !== modelContext.loaded
      ? `model max ${modelContext.max.toLocaleString()}`
      : null

  return (
    <div className="flex flex-col gap-2">
      <span
        className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
        title="Tokens the conversation carries into the next turn, estimated with the cl100k tokenizer. Local models typically count 10-30% higher. Tool payloads are dropped from memory after each turn."
      >
        Context used
      </span>
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-3xl font-semibold tabular-nums">
            ~{conversationTokens.toLocaleString()}
          </span>
          {budget != null ? (
            <span className="font-mono text-base text-muted-foreground tabular-nums">
              / {budget.toLocaleString()}
            </span>
          ) : (
            <span className="text-sm text-muted-foreground">tokens</span>
          )}
        </div>
        {budget != null ? (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {pctLabel}
          </span>
        ) : null}
      </div>
      {budget != null ? (
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="absolute inset-y-0 left-0 rounded-full serpapi-gradient transition-[width] duration-500 ease-out"
            style={{ width: `${Math.max(0.5, pctUsed)}%` }}
          />
        </div>
      ) : null}
      <div className="flex justify-between font-mono text-[11px] text-muted-foreground tabular-nums">
        <span
          title={
            exactUsage
              ? "Ground truth from LM Studio for this turn's final inference call. The tool-picking call is counted separately, and the output includes any hidden reasoning tokens."
              : "Estimated with the cl100k tokenizer."
          }
        >
          {exactUsage
            ? `${exactUsage.promptTokens.toLocaleString()} in · ${exactUsage.completionTokens.toLocaleString()} out · final call`
            : `~${lastTurnTotal.toLocaleString()} tokens this turn`}
        </span>
        {maxLabel ? <span>{maxLabel}</span> : null}
      </div>
    </div>
  )
}

type OrderedSegment = {
  key: keyof Breakdown
  label: string
  description: string
  count: number
  pct: number
  color: string
}

function StackedBar({
  segments,
  total,
}: {
  segments: Array<OrderedSegment>
  total: number
}) {
  if (total === 0) return null
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-muted">
      {segments.map((seg) => {
        if (seg.count === 0) return null
        return (
          <div
            key={seg.key}
            className={`${seg.color} transition-[width] duration-500 ease-out`}
            style={{ width: `${seg.pct * 100}%` }}
            title={`${seg.label}: ${seg.count.toLocaleString()} (${Math.round(seg.pct * 100)}%)`}
          />
        )
      })}
    </div>
  )
}

function SegmentList({ segments }: { segments: Array<OrderedSegment> }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {segments.map((seg) => {
        const pct = Math.round(seg.pct * 100)
        return (
          <li
            key={seg.key}
            title={seg.description}
            className="flex items-center gap-2.5 text-sm"
          >
            <span
              aria-hidden
              className={`${seg.color} h-2 w-2 shrink-0 rounded-full`}
            />
            <span className="flex-1 truncate">{seg.label}</span>
            <span className="font-mono tabular-nums">
              {seg.count.toLocaleString()}
            </span>
            <span className="w-9 text-right font-mono text-xs text-muted-foreground tabular-nums">
              {pct > 0 ? `${pct}%` : seg.count > 0 ? "<1%" : "–"}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function LatencyCard({
  phases,
  completionTokens,
}: {
  phases: Phases
  completionTokens: number | null
}) {
  // WHY: with no tool call there is no second inference — the first call
  //      IS the answer, so labelling it "Pick tool" would be wrong.
  const directAnswer =
    phases.toolExecutionMs === 0 && phases.secondInferenceMs === 0
  const segments: Array<{
    key: keyof Phases
    label: string
    color: string
  }> = [
    {
      key: "firstInferenceMs",
      label: directAnswer ? "Answer" : "Pick tool",
      color: "bg-serpapi-blue",
    },
    {
      key: "toolExecutionMs",
      label: "SerpApi",
      color: "bg-serpapi-purple",
    },
    {
      key: "secondInferenceMs",
      label: "Answer",
      color: "bg-serpapi-violet",
    },
  ]
  const total = segments.reduce((sum, s) => sum + phases[s.key], 0)
  if (total === 0) return null

  // Tokens/sec on the answer call. Uses exactUsage.completionTokens (from
  // LM Studio) divided by the phase that actually generated the answer —
  // the second call after tools, or the first (and only) call on a direct
  // answer. Gives a practical "how fast is this machine running this
  // model" number either way.
  const answerMs = directAnswer
    ? phases.firstInferenceMs
    : phases.secondInferenceMs
  const tokPerSec =
    completionTokens != null && answerMs > 0
      ? Math.round(completionTokens / (answerMs / 1000))
      : null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          Latency
        </span>
        <span className="font-mono text-xs tabular-nums">
          {(total / 1000).toFixed(2)}s
          {tokPerSec != null ? (
            <span className="ml-1.5 text-muted-foreground">
              · {tokPerSec} tok/s
            </span>
          ) : null}
        </span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
        {segments.map((s) => {
          const ms = phases[s.key]
          if (ms === 0) return null
          return (
            <div
              key={s.key}
              className={`${s.color} transition-[width] duration-500 ease-out`}
              style={{ width: `${(ms / total) * 100}%` }}
              title={`${s.label}: ${ms}ms`}
            />
          )
        })}
      </div>
      <ul className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        {segments.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className={`${s.color} h-1.5 w-1.5 shrink-0 rounded-full`}
            />
            <span className="flex-1 truncate text-muted-foreground">
              {s.label}
            </span>
            <span className="font-mono tabular-nums">{phases[s.key]}ms</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// Shows what the JSON Restrictor did in one glance: the full SerpApi
// response vs. the filtered payload the model received. The full-response
// measurement is fetched once per turn by the page and passed in via
// `fullFetch`.
function JsonRestrictorCard({
  toolCalls,
  fullFetch,
  onInspect,
}: {
  toolCalls: Array<ToolCallInfo>
  fullFetch: FullFetchState
  onInspect?: () => void
}) {
  const filteredTokens = toolCalls.reduce((sum, c) => sum + c.tokens, 0)
  const filteredMs = toolCalls.reduce((sum, c) => sum + c.serpApiMs, 0)

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          JSON Restrictor
        </span>
        <Badge
          variant="outline"
          className="gap-1 font-mono text-[10px] tracking-wide uppercase"
        >
          server-side
        </Badge>
      </div>

      {fullFetch.status === "done" ? (
        <ReductionView
          fullTokens={fullFetch.results.reduce((s, r) => s + r.tokens, 0)}
          filteredTokens={filteredTokens}
          fullMs={fullFetch.results.reduce((s, r) => s + r.serpApiMs, 0)}
          filteredMs={filteredMs}
        />
      ) : (
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] text-muted-foreground">
            Filtered for the model
          </span>
          <span className="font-mono text-base font-semibold tabular-nums">
            {filteredTokens.toLocaleString()} tok
          </span>
        </div>
      )}

      {fullFetch.status === "loading" ? (
        <TextShimmerLoader text="Measuring the full response…" size="sm" />
      ) : null}

      {onInspect ? (
        <Button
          variant="outline"
          size="sm"
          onClick={onInspect}
          className="w-full justify-center gap-1.5"
        >
          <Braces className="h-3.5 w-3.5" />
          Inspect full JSON
        </Button>
      ) : null}
    </div>
  )
}

// The before/after the user reads first: a big "N% smaller", then two bars
// on the same scale — a full muted bar for the raw response and a gradient
// sliver for what the model received.
function ReductionView({
  fullTokens,
  filteredTokens,
  fullMs,
  filteredMs,
}: {
  fullTokens: number
  filteredTokens: number
  fullMs: number
  filteredMs: number
}) {
  // NOTE: the "full" response comes from a separate, later SerpApi call,
  //       so on volatile engines (news, finance) it can legitimately come
  //       back smaller than the filtered one — clamp instead of showing a
  //       negative "smaller" or an Infinity-wide bar.
  const smallerPct =
    fullTokens > 0
      ? Math.max(0, Math.round((1 - filteredTokens / fullTokens) * 100))
      : 0
  const msSaved = fullMs - filteredMs
  const filteredWidth =
    fullTokens > 0
      ? Math.max(2, Math.min(100, (filteredTokens / fullTokens) * 100))
      : 100

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-baseline gap-1.5">
        <span className="font-mono text-2xl font-semibold tabular-nums">
          {smallerPct}%
        </span>
        <span className="text-sm text-muted-foreground">smaller</span>
        {msSaved > 0 ? (
          <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
            {(msSaved / 1000).toFixed(2)}s faster
          </span>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <ReductionBar
          label="Full"
          tokens={fullTokens}
          widthPct={100}
          tone="muted"
        />
        <ReductionBar
          label="Filtered"
          tokens={filteredTokens}
          widthPct={filteredWidth}
          tone="gradient"
        />
      </div>
    </div>
  )
}

function ReductionBar({
  label,
  tokens,
  widthPct,
  tone,
}: {
  label: string
  tokens: number
  widthPct: number
  tone: "muted" | "gradient"
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 shrink-0 text-[11px] text-muted-foreground">
        {label}
      </span>
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${
            tone === "gradient" ? "serpapi-gradient" : "bg-muted-foreground/40"
          }`}
          style={{ width: `${widthPct}%` }}
        />
      </div>
      <span className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums">
        {tokens.toLocaleString()}
      </span>
    </div>
  )
}
