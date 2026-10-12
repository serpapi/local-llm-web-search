import { Link, createFileRoute } from "@tanstack/react-router"
import {
  ArrowUpRight,
  BarChart3,
  Braces,
  CheckCircle2,
  ChevronDown,
  Eraser,
  FlaskConical,
  Loader2,
  Moon,
  Scale,
  Send,
  Sparkles,
  Sun,
  Wrench,
} from "lucide-react"
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"
import { useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"
import type { ReactNode } from "react"

import type {
  ChatMessage,
  ChatSearches,
  ChatSession,
  ModelContextSnapshot,
  ToolCallSummary,
} from "@/lib/chat"
import type {
  Breakdown,
  ExactUsage,
  ModelInfo,
  Phases,
  QueryProgress,
  Source,
  ToolCallInfo,
  ToolOutput,
} from "@/lib/agent-types"
import type { FullFetchState } from "@/hooks/use-full-responses"
import type { ChatTurnInput } from "@/server/chat"
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
import {
  FULL_FETCH_FAILED,
  RestrictorDialog,
} from "@/components/restrictor-dialog"
import { ModelSelector } from "@/components/model-selector"
import { buildExamples } from "@/lib/examples"
import { pickDefaultModel } from "@/lib/models"
import { useTheme } from "@/hooks/use-theme"
import { useFullResponses } from "@/hooks/use-full-responses"
import {
  PromptInput,
  PromptInputAction,
  PromptInputActions,
  PromptInputTextarea,
} from "@/components/ui/prompt-input"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  CONTEXT_SEGMENTS,
  TOOL_OUTPUTS,
  TOOL_OUTPUT_META,
  contextTotal,
  fitBreakdown,
  isToolOutput,
} from "@/lib/agent-types"
import { listModels } from "@/server/models"
import {
  chatQueries,
  clearChatSession,
  restoreChatSession,
  sendChatMessage,
} from "@/server/chat"

export const Route = createFileRoute("/")({
  // WHY: the model list is route data, so it loads with the route instead of
  //      in a client effect. Errors come back as data, not thrown. LM Studio
  //      being offline is a normal state the composer explains inline. The
  //      chat session goes into the query cache with it, so a reload renders
  //      the conversation (and a turn still running) straight away.
  loader: async ({ context }): Promise<ChatLoaderData> => {
    const [models] = await Promise.all([
      listModels().then(
        (list) => ({ models: list, error: null }),
        (err: unknown) => ({
          models: [],
          error: err instanceof Error ? err.message : String(err),
        })
      ),
      context.queryClient.query(chatQueries.session()),
    ])
    return models
  },
  head: () => ({ meta: [{ title: "SerpApi Local Agent Lab" }] }),
  // WHY: the HTML carries the chat session the cookie names, so no cache
  //      may keep it or hand it to another browser.
  headers: () => ({ "Cache-Control": "private, no-store" }),
  component: App,
})

type ChatLoaderData = {
  models: Array<ModelInfo>
  error: string | null
}

const TOOL_OUTPUT_STORAGE_KEY = "local-llm-web-search:tool-output"
const MODEL_STORAGE_KEY = "local-llm-web-search:model"

// WHY: storage throws when the browser blocks it. A saved choice is a
//      convenience, so the page carries on without it.
function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    // The choice then lasts until the page reloads.
  }
}

// The SerpApi outputs the model can receive as tool results, in the order
// the selector lists them. Copy lives in `TOOL_OUTPUT_META` so /bench and
// the chat composer describe each mode the same way.
const TOOL_OUTPUT_OPTIONS = TOOL_OUTPUTS.map((value) => ({
  value,
  ...TOOL_OUTPUT_META[value],
}))

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

const NO_TOOL_CALLS: Array<ToolCallInfo> = []

// What to do when LM Studio can't be reached. The model selector carries
// the error itself.
const LM_STUDIO_DOWN_HINT =
  "Start the server from LM Studio's Developer tab, then reload."

// How often the page checks on a running turn.
const POLL_MS = 500

// On the restrictor card's sizes, which compare two SerpApi responses
// offline rather than report what LM Studio counted.
const CL100K_NOTE =
  "Counted with tiktoken's cl100k_base, as on /bench, so the full and filtered sizes use the same ruler. The model's own tokenizer counts a few percent more."

function App() {
  const { models: availableModels, error: modelsError } = Route.useLoaderData()
  const queryClient = useQueryClient()
  // The conversation lives on the server (`src/server/chat.ts`). The query
  // cache holds the page's copy; the loader filled it.
  const { data: session } = useSuspenseQuery(chatQueries.session())
  const { messages, last } = session
  const turn = session.pending
  const turnRunning = turn !== null
  // The sidebar shows the last turn that succeeded; a failed turn leaves
  // its numbers as they were.
  const latestToolCalls = last?.toolCalls ?? NO_TOOL_CALLS
  const { fullFetch, canMeasure, measure } = useFullResponses(
    last?.turnId ?? null,
    latestToolCalls
  )
  const undoToastId = useRef<string | number | null>(null)
  const [rawFormattedOpen, setRawFormattedOpen] = useState(false)
  const [input, setInput] = useState("")

  // WHY: poll the small status while a turn runs and read the whole
  //      session once it ends. The full session carries every tool
  //      response of the conversation, too heavy to fetch twice a second.
  const statusQuery = useQuery({
    ...chatQueries.status(session.id, turn?.startedAt ?? null),
    enabled: turnRunning,
    refetchInterval: POLL_MS,
  })
  const status = statusQuery.data
  const stillRunning =
    status !== undefined &&
    status.id === session.id &&
    status.pending?.startedAt === turn?.startedAt
  useEffect(() => {
    if (!turnRunning || status === undefined || stillRunning) return
    // Done, or another tab switched the session: adopt the server's. A
    // failed read keeps the last state on screen; the next poll retries.
    queryClient
      .fetchQuery({ ...chatQueries.session(), staleTime: 0 })
      .catch(() => {})
    // WHY: `dataUpdatedAt`, not `status`: an unchanged poll keeps the same
    //      object, and a failed session read must try again on the next one.
  }, [statusQuery.dataUpdatedAt])

  const setSession = (next: ChatSession) =>
    queryClient.setQueryData(chatQueries.session().queryKey, next)

  const send = useMutation({
    mutationFn: (data: ChatTurnInput) => sendChatMessage({ data }),
    onSuccess: setSession,
    onError: (err, data) => {
      setInput(data.question)
      toast.error(`Could not send the question: ${err.message}`)
    },
  })
  // Undo points the browser back at the old session, which the server
  // keeps for a day.
  const restore = useMutation({
    mutationFn: (id: string) => restoreChatSession({ data: { id } }),
    onSuccess: setSession,
    onError: (err) => {
      toast.error(`Could not restore the chat: ${err.message}`)
    },
  })
  // Clear starts a new server session.
  const clear = useMutation({
    mutationFn: () => clearChatSession(),
    onSuccess: ({ session: fresh, previousId }) => {
      setSession(fresh)
      undoToastId.current = toast("Chat cleared", {
        action: { label: "Undo", onClick: () => restore.mutate(previousId) },
      })
    },
    onError: (err) => {
      toast.error(`Could not clear the chat: ${err.message}`)
    },
  })

  // `send.isPending` covers pressing Send until the server confirms the turn.
  const isLoading = send.isPending || turnRunning
  const [selectedModel, setSelectedModel] = useState<ModelInfo | null>(() =>
    pickDefaultModel(availableModels)
  )
  const { theme, toggleTheme } = useTheme()
  // Which SerpApi output the model gets as tool results. Persisted like the
  // theme; applies from the next question on.
  const [toolOutput, setToolOutput] = useState<ToolOutput>("markdown")

  useEffect(() => {
    const stored = readStored(TOOL_OUTPUT_STORAGE_KEY)
    if (isToolOutput(stored)) setToolOutput(stored)
    // The chat survives a reload, so the model it was talking to should too.
    const storedModel = readStored(MODEL_STORAGE_KEY)
    const match = availableModels.find((m) => m.id === storedModel)
    if (match) setSelectedModel(match)
  }, [availableModels])

  function changeToolOutput(next: ToolOutput) {
    setToolOutput(next)
    writeStored(TOOL_OUTPUT_STORAGE_KEY, next)
  }

  const canSubmit = Boolean(selectedModel) && !modelsError

  function submit() {
    const question = input.trim()
    if (!question || isLoading || !selectedModel) return
    // Undo would switch to the old chat and hide the answer about to run.
    if (undoToastId.current !== null) toast.dismiss(undoToastId.current)
    setInput("")
    send.mutate({
      question,
      model: selectedModel.id,
      contextLength: selectedModel.recommendedContextLength,
      maxContextLength: selectedModel.maxContextLength,
      toolUseTrained: selectedModel.toolUseTrained,
      toolOutput,
    })
  }

  function clearChat() {
    setRawFormattedOpen(false)
    clear.mutate()
  }

  return (
    <div className="flex min-h-svh flex-col bg-muted/40 lg:h-svh lg:overflow-hidden">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6 lg:min-h-0 lg:flex-1 lg:overflow-hidden">
        <Header theme={theme} onToggleTheme={toggleTheme} />
        <RestrictorDialog
          open={rawFormattedOpen}
          onOpenChange={setRawFormattedOpen}
          toolCalls={latestToolCalls}
          fullResults={
            fullFetch.status === "done" ? fullFetch.results : undefined
          }
          fullLoading={fullFetch.status === "loading"}
          fullError={fullFetch.status === "error" ? fullFetch.message : null}
        />
        <div className="grid gap-6 lg:min-h-0 lg:flex-1 lg:grid-cols-[minmax(0,1fr)_380px] lg:overflow-hidden">
          <ChatPanel
            messages={messages}
            input={input}
            setInput={setInput}
            isLoading={isLoading}
            progress={(status?.pending ?? turn)?.progress ?? null}
            onSubmit={submit}
            onClear={clearChat}
            canSubmit={canSubmit}
            turnsInMemory={session.turnsInMemory}
            trimmedTurns={last?.trimmedTurns ?? 0}
            availableModels={availableModels}
            selectedModel={selectedModel}
            onSelectModel={(id) => {
              const match = availableModels.find((m) => m.id === id)
              if (!match) return
              setSelectedModel(match)
              writeStored(MODEL_STORAGE_KEY, match.id)
            }}
            modelsError={modelsError}
            toolOutput={toolOutput}
            onChangeToolOutput={changeToolOutput}
          />
          <BreakdownPanel
            breakdown={last?.breakdown ?? null}
            exactUsage={last?.exactUsage ?? null}
            totalUsage={last?.totalUsage ?? null}
            phases={last?.phases ?? null}
            modelContext={last?.modelContext ?? null}
            conversationTokens={last?.conversationTokens ?? 0}
            toolCalls={latestToolCalls}
            searches={session.searches}
            lastTurnSearches={last?.searches ?? null}
            fullFetch={fullFetch}
            onMeasureFull={canMeasure ? measure : undefined}
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
  theme,
  onToggleTheme,
}: {
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
            SerpApi Local Agent Lab
          </h1>
          <p className="text-sm text-muted-foreground">
            Local inference using{" "}
            <span className="font-medium text-foreground">LM Studio</span> and
            live web data by{" "}
            <span className="font-medium text-foreground">SerpApi</span>
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {import.meta.env.DEV ? (
          // WHY: /bench returns 404 outside `bun run dev`, so the link only
          //      exists where the page does.
          <Button asChild variant="outline" size="lg">
            <Link to="/bench">
              <BarChart3 data-icon="inline-start" />
              Benchmark
            </Link>
          </Button>
        ) : null}
        <Button
          type="button"
          variant="outline"
          size="icon-lg"
          onClick={onToggleTheme}
          aria-label={
            theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
          }
        >
          {theme === "dark" ? <Sun /> : <Moon />}
        </Button>
      </div>
    </header>
  )
}

// Picks which SerpApi output feeds the model: the structured JSON response
// or SerpApi's Markdown output (https://serpapi.com/markdown-output), with
// or without the restrictor.
function ToolOutputSelector({
  value,
  onChange,
}: {
  value: ToolOutput
  onChange: (output: ToolOutput) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="lg" aria-label="Tool output">
          <Braces data-icon="inline-start" />
          {TOOL_OUTPUT_META[value].label}
          <ChevronDown
            data-icon="inline-end"
            className="text-muted-foreground"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(v) => {
            if (isToolOutput(v)) onChange(v)
          }}
        >
          {TOOL_OUTPUT_OPTIONS.map((o) => (
            <DropdownMenuRadioItem
              key={o.value}
              value={o.value}
              title={o.description}
            >
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
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
          size="lg"
          variant="outline"
          disabled={disabled}
          aria-label="Open examples"
        >
          <FlaskConical data-icon="inline-start" />
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
          <span className="px-1 text-sm font-semibold">Examples</span>
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
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => {
                          onPick(q.question)
                          setOpen(false)
                        }}
                        className="w-full justify-start gap-2 text-left"
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
                        <ArrowUpRight
                          data-icon="inline-end"
                          className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover/button:opacity-100 group-focus-visible/button:opacity-100"
                        />
                      </Button>
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
  availableModels,
  selectedModel,
  onSelectModel,
  modelsError,
  toolOutput,
  onChangeToolOutput,
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
  availableModels: Array<ModelInfo>
  selectedModel: ModelInfo | null
  onSelectModel: (id: string) => void
  modelsError: string | null
  toolOutput: ToolOutput
  onChangeToolOutput: (output: ToolOutput) => void
}) {
  const disabled = isLoading || !canSubmit
  // Only once there is history: how many earlier turns the model is sent
  // again with each question. A failed turn is not kept.
  const description =
    turnsInMemory === 0
      ? null
      : `${turnsInMemory} turn${turnsInMemory === 1 ? "" : "s"} of history${
          trimmedTurns > 0
            ? ` · ${trimmedTurns} older turn${trimmedTurns === 1 ? "" : "s"} dropped to fit`
            : ""
        }`
  return (
    <Card className="flex min-h-[70svh] flex-col gap-0 overflow-hidden py-0 lg:h-full lg:min-h-0">
      <CardHeader className="shrink-0 border-b py-4">
        <CardTitle>Chat</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        <CardAction>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClear}
            disabled={isLoading || messages.length === 0}
            className="text-muted-foreground"
          >
            <Eraser data-icon="inline-start" aria-hidden />
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
              modelsError !== null
                ? LM_STUDIO_DOWN_HINT
                : canSubmit
                  ? "Ask anything that needs real-world data..."
                  : "Load a model in LM Studio to start..."
            }
          />
          <PromptInputActions className="justify-between gap-2 pt-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <ExamplesPopover onPick={setInput} disabled={disabled} />
              <ModelSelector
                availableModels={availableModels}
                selectedModel={selectedModel}
                onSelectModel={onSelectModel}
                modelsError={modelsError}
              />
              <ToolOutputSelector
                value={toolOutput}
                onChange={onChangeToolOutput}
              />
            </div>
            <PromptInputAction
              tooltip={isLoading ? "Waiting for the model…" : "Send"}
            >
              <Button
                type="button"
                variant="brand"
                size="icon-lg"
                onClick={onSubmit}
                disabled={disabled || !input.trim()}
                aria-label={
                  isLoading ? "Waiting for the model" : "Send message"
                }
                aria-busy={isLoading}
              >
                {isLoading ? (
                  <Loader2 className="animate-spin" aria-hidden />
                ) : (
                  <Send aria-hidden />
                )}
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

function ToolCallsPanel({ toolCalls }: { toolCalls: Array<ToolCallSummary> }) {
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
  // Calls in one round ran in parallel; a later round searched again after
  // reading the results.
  const rounds = Math.max(...toolCalls.map((c) => c.round ?? 1))
  const heading =
    toolCalls.length === 1 ? null : (
      <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
        {rounds > 1
          ? `${toolCalls.length} tool calls in ${rounds} rounds`
          : `${toolCalls.length} parallel tool calls`}
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

function ToolBadge({ toolCall }: { toolCall: ToolCallSummary }) {
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
  totalUsage,
  phases,
  modelContext,
  conversationTokens,
  toolCalls,
  searches,
  lastTurnSearches,
  fullFetch,
  onMeasureFull,
  onInspectRaw,
}: {
  breakdown: Breakdown | null
  exactUsage: ExactUsage | null
  totalUsage: TurnUsage | null
  phases: Phases | null
  modelContext: ModelContextSnapshot | null
  conversationTokens: number
  toolCalls: Array<ToolCallInfo>
  searches: ChatSearches
  lastTurnSearches: number | null
  fullFetch: FullFetchState
  onMeasureFull?: () => void
  onInspectRaw?: () => void
}) {
  const searchCard =
    searches.model + searches.compare > 0 ? (
      <SearchesCard searches={searches} lastTurn={lastTurnSearches} />
    ) : null
  return (
    <Card className="flex flex-col lg:h-full lg:min-h-0">
      <CardHeader className="shrink-0 pb-3">
        <CardTitle>Token breakdown</CardTitle>
        <CardDescription>
          What the model read and wrote on its last call.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 lg:min-h-0 lg:flex-1 lg:overflow-y-auto">
        {breakdown === null ? (
          <>
            <EmptyBreakdown />
            {searchCard}
          </>
        ) : (
          <BreakdownBody
            breakdown={breakdown}
            exactUsage={exactUsage}
            totalUsage={totalUsage}
            phases={phases}
            modelContext={modelContext}
            conversationTokens={conversationTokens}
            toolCalls={toolCalls}
            searchCard={searchCard}
            fullFetch={fullFetch}
            onMeasureFull={onMeasureFull}
            onInspectRaw={onInspectRaw}
          />
        )}
      </CardContent>
    </Card>
  )
}

type TurnUsage = ExactUsage & { completions: number }

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
  totalUsage,
  phases,
  modelContext,
  conversationTokens,
  toolCalls,
  searchCard,
  fullFetch,
  onMeasureFull,
  onInspectRaw,
}: {
  breakdown: Breakdown
  exactUsage: ExactUsage | null
  totalUsage: TurnUsage | null
  phases: Phases | null
  modelContext: ModelContextSnapshot | null
  conversationTokens: number
  toolCalls: Array<ToolCallInfo>
  searchCard: ReactNode
  fullFetch: FullFetchState
  onMeasureFull?: () => void
  onInspectRaw?: () => void
}) {
  // WHY: the segments are estimates and LM Studio's count is exact, so the
  //      segments are fitted to it: they keep their shares and add up to
  //      the number LM Studio reported. Without usage they stay estimates.
  const fit = exactUsage ? fitBreakdown(breakdown, exactUsage) : null
  const shown = fit?.breakdown ?? breakdown
  const total = contextTotal(shown)

  // Rank segments by size so the compact list leads with the biggest movers.
  const orderedSegments = [...CONTEXT_SEGMENTS]
    .map((seg) => ({
      ...seg,
      count: shown[seg.key],
      pct: total > 0 ? shown[seg.key] / total : 0,
      color: SEGMENT_COLORS[seg.key],
    }))
    .sort((a, b) => b.count - a.count)

  return (
    <div className="flex flex-col gap-5">
      <HeroTotal
        total={total}
        exactUsage={exactUsage}
        modelContext={modelContext}
      />
      <StackedBar segments={orderedSegments} total={total} />
      <SegmentList segments={orderedSegments} fitted={fit !== null} />
      <TurnSummary
        totalUsage={totalUsage}
        nextQuestionTokens={Math.round(conversationTokens * (fit?.ratio ?? 1))}
      />
      {searchCard}
      {phases ? <LatencyCard phases={phases} /> : null}
      {toolCalls.length > 0 ? (
        <JsonRestrictorCard
          toolCalls={toolCalls}
          fullFetch={fullFetch}
          onMeasure={onMeasureFull}
          onInspect={onInspectRaw}
        />
      ) : null}
    </div>
  )
}

function HeroTotal({
  total,
  exactUsage,
  modelContext,
}: {
  total: number
  exactUsage: ExactUsage | null
  modelContext: ModelContextSnapshot | null
}) {
  const budget = modelContext?.loaded ?? null
  const pctUsed = budget && budget > 0 ? (total / budget) * 100 : 0
  const pctLabel =
    budget && pctUsed > 0 && pctUsed < 1 ? "<1%" : `${Math.round(pctUsed)}%`
  const maxLabel =
    modelContext && modelContext.max !== modelContext.loaded
      ? `model max ${modelContext.max.toLocaleString()}`
      : null
  const reasoning = exactUsage?.reasoningTokens ?? 0

  return (
    <div className="flex flex-col gap-2">
      <span
        className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
        title="Everything the model read and wrote on the last call of this turn, as LM Studio counted it with the model's own tokenizer and chat template. The segments below share that total in proportion to estimates from a generic tokenizer."
      >
        Context used
      </span>
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-3xl font-semibold tabular-nums">
            {exactUsage ? "" : "~"}
            {total.toLocaleString()}
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
      <div className="flex justify-between gap-2 font-mono text-[11px] text-muted-foreground tabular-nums">
        <span
          title={
            exactUsage
              ? "LM Studio's count for the last call. The output includes the tokens the model spent reasoning."
              : "LM Studio sent no usage for this call, so the total is estimated with the cl100k tokenizer."
          }
        >
          {exactUsage
            ? `${exactUsage.promptTokens.toLocaleString()} in · ${exactUsage.completionTokens.toLocaleString()} out${
                reasoning > 0
                  ? ` (${reasoning.toLocaleString()} reasoning)`
                  : ""
              }`
            : "estimated"}
        </span>
        {maxLabel ? <span>{maxLabel}</span> : null}
      </div>
    </div>
  )
}

// The rest of the turn: what every call read, and what the next question
// starts from. Explains why the context grows so little between questions.
function TurnSummary({
  totalUsage,
  nextQuestionTokens,
}: {
  totalUsage: TurnUsage | null
  nextQuestionTokens: number
}) {
  return (
    <ul className="flex flex-col gap-1 font-mono text-[11px] text-muted-foreground tabular-nums">
      {totalUsage && totalUsage.completions > 1 ? (
        <li
          className="flex justify-between gap-2"
          title="Every call LM Studio ran for this answer. Each call reads the whole conversation so far again, so a turn reads much more than its last call."
        >
          <span>This turn, {totalUsage.completions} calls</span>
          <span>
            {totalUsage.promptTokens.toLocaleString()} in ·{" "}
            {totalUsage.completionTokens.toLocaleString()} out
          </span>
        </li>
      ) : null}
      <li
        className="flex justify-between gap-2"
        title="Tool definitions, system prompt and history: what the next question starts from. Search results are not kept between questions, only the questions and answers."
      >
        <span>Next question starts at</span>
        <span>~{nextQuestionTokens.toLocaleString()}</span>
      </li>
    </ul>
  )
}

// What this chat has spent on SerpApi, so a model that searches three
// times is visible. The full-response checks are the searches the
// restrictor card re-runs without the restrictor to measure the saving.
function SearchesCard({
  searches,
  lastTurn,
}: {
  searches: ChatSearches
  lastTurn: number | null
}) {
  const rows: Array<{ label: string; value: number | null; title: string }> = [
    {
      label: "Last answer",
      value: lastTurn,
      title: "Searches the model ran for the last answer.",
    },
    {
      label: "By the model",
      value: searches.model,
      title:
        "Every search the model ran in this chat, failed answers included.",
    },
    {
      label: "Full-response checks",
      value: searches.compare,
      title:
        "Each search re-run once without the restrictor, to measure what the restrictor saved.",
    },
  ]
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span
          className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase"
          title="Each search costs one SerpApi credit, unless SerpApi serves it from its one-hour cache."
        >
          SerpApi searches
        </span>
        <span className="font-mono text-xs tabular-nums">
          {(searches.model + searches.compare).toLocaleString()} this chat
        </span>
      </div>
      <ul className="flex flex-col gap-1 text-[11px]">
        {rows.map((row) => (
          <li
            key={row.label}
            title={row.title}
            className="flex items-center justify-between gap-2"
          >
            <span className="text-muted-foreground">{row.label}</span>
            <span className="font-mono tabular-nums">{row.value ?? "–"}</span>
          </li>
        ))}
      </ul>
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

// "~" marks an estimate. With LM Studio's usage, the output is its exact
// count and the input parts are estimates scaled to its exact total.
function SegmentList({
  segments,
  fitted,
}: {
  segments: Array<OrderedSegment>
  fitted: boolean
}) {
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
              {seg.count > 0 && !(fitted && seg.key === "final_response")
                ? "~"
                : ""}
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

function LatencyCard({ phases }: { phases: Phases }) {
  // WHY: with no tool call there is no second inference. The first call
  //      IS the answer, so labelling it "Pick tool" would be wrong.
  const directAnswer =
    phases.toolExecutionMs === 0 && phases.secondInferenceMs === 0
  // NOTE: no tokens/sec here. It divided the last call's output by the
  //       time of every call after the first search, retries included, and
  //       without streaming the app can't separate the time LM Studio spends
  //       reading the prompt from the time it spends writing.
  const segments = (
    [
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
    ] as const
  ).filter((s) => phases[s.key] > 0)
  const total = segments.reduce((sum, s) => sum + phases[s.key], 0)
  if (total === 0) return null

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          Latency
        </span>
        <span className="font-mono text-xs tabular-nums">
          {(total / 1000).toFixed(2)}s
        </span>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
        {segments.map((s) => (
          <div
            key={s.key}
            className={`${s.color} transition-[width] duration-500 ease-out`}
            style={{ width: `${(phases[s.key] / total) * 100}%` }}
            title={`${s.label}: ${phases[s.key]}ms`}
          />
        ))}
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
// response vs. the filtered payload the model received. The full response
// costs one more search per tool call, so it is fetched only when the user
// asks (`onMeasure`) and passed in via `fullFetch`. When the turn ran
// without a restrictor the card just reports what the model received.
// Both sizes are cl100k counts, the ruler /bench uses, not LM Studio's.
function JsonRestrictorCard({
  toolCalls,
  fullFetch,
  onMeasure,
  onInspect,
}: {
  toolCalls: Array<ToolCallInfo>
  fullFetch: FullFetchState
  onMeasure?: () => void
  onInspect?: () => void
}) {
  const filteredTokens = toolCalls.reduce((sum, c) => sum + c.tokens, 0)
  const output = toolCalls[0]?.output ?? "json"
  const restricted = toolCalls.every((c) => c.restrictor !== null)
  const outputLabel = output === "json" ? "JSON" : "Markdown"

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
          {restricted ? "JSON Restrictor" : "SerpApi response"}
        </span>
        <Badge
          variant="outline"
          className="gap-1 font-mono text-[10px] tracking-wide uppercase"
        >
          {outputLabel}
        </Badge>
      </div>

      {fullFetch.status === "done" ? (
        <ReductionView
          fullTokens={fullFetch.results.reduce((s, r) => s + r.tokens, 0)}
          filteredTokens={filteredTokens}
        />
      ) : (
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] text-muted-foreground">
            {restricted ? "Filtered for the model" : "Sent to the model"}
          </span>
          <span
            title={CL100K_NOTE}
            className="font-mono text-base font-semibold tabular-nums"
          >
            ~{filteredTokens.toLocaleString()} tok
          </span>
        </div>
      )}

      {onMeasure &&
      (fullFetch.status === "idle" || fullFetch.status === "error") ? (
        <div className="flex flex-col gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={onMeasure}
            className="w-full justify-center gap-1.5"
          >
            <Scale data-icon="inline-start" aria-hidden />
            Compare with the full response
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Runs {toolCalls.length === 1 ? "the search" : "each search"} again
            without the restrictor: {toolCalls.length} more SerpApi{" "}
            {toolCalls.length === 1 ? "search" : "searches"}.
          </p>
        </div>
      ) : null}

      {fullFetch.status === "loading" ? (
        <TextShimmerLoader text="Measuring the full response…" size="sm" />
      ) : null}

      {fullFetch.status === "error" ? (
        <p title={fullFetch.message} className="text-[11px] text-destructive">
          {FULL_FETCH_FAILED}
        </p>
      ) : null}

      {onInspect ? (
        <Button
          variant="outline"
          size="sm"
          onClick={onInspect}
          className="w-full justify-center gap-1.5"
        >
          <Braces data-icon="inline-start" aria-hidden />
          {restricted ? "Inspect full response" : "Inspect response"}
        </Button>
      ) : null}
    </div>
  )
}

// The before/after the user reads first: a big "N% smaller", then two bars
// on the same scale: a full muted bar for the raw response and a gradient
// sliver for what the model received.
function ReductionView({
  fullTokens,
  filteredTokens,
}: {
  fullTokens: number
  filteredTokens: number
}) {
  // NOTE: the "full" response comes from a separate, later SerpApi call,
  //       so on volatile engines (news, finance) it can legitimately come
  //       back smaller than the filtered one. Clamp instead of showing a
  //       negative "smaller" or an Infinity-wide bar.
  const smallerPct =
    fullTokens > 0
      ? Math.max(0, Math.round((1 - filteredTokens / fullTokens) * 100))
      : 0
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
      <span
        title={CL100K_NOTE}
        className="w-16 shrink-0 text-right font-mono text-[11px] tabular-nums"
      >
        ~{tokens.toLocaleString()}
      </span>
    </div>
  )
}
