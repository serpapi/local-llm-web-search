// Server-only chat sessions. The `.server.ts` suffix keeps this file, the
// cookie helpers and the agent loop it calls out of the browser bundle;
// `chat.functions.ts` exposes it to the page through thin server functions.

import {
  getCookie,
  setCookie,
  setResponseHeader,
} from "@tanstack/react-start/server"
import { z } from "zod"

import {
  fetchFullResponse,
  historyMessageSchema,
  readQueryProgress,
  runAgentTurn,
} from "./agent.server"
import type { RunQueryInput, RunQueryResult } from "./agent.server"
import type {
  FullResponseResult,
  QueryProgress,
  ToolCallInfo,
} from "@/lib/agent-types"
import type {
  ChatMessage,
  ChatSearches,
  ChatSession,
  ChatStatus,
  ChatTurnInput,
  ChatTurnStats,
} from "@/lib/chat"

// WHY: the page used to hold the whole conversation in React state and run
//      each answer as one browser request, so a reload or a closed tab lost
//      the chat, and an answer still being written was dropped. The session
//      now lives here: the page starts a turn, polls `chatStatus` while it
//      runs, and reads the session back on load. An httpOnly cookie names
//      the session, so the server-rendered page already has the messages.
//
//      Sessions sit on `globalThis` so a Vite HMR reload of this module
//      keeps them. They are in memory only: a server restart starts fresh.

type SessionState = {
  id: string
  messages: Array<ChatMessage>
  // The model's view of the conversation (`RunQueryResult.messages`).
  conversation: RunQueryResult["messages"]
  last: ChatTurnStats | null
  // Turns trimmed out of `conversation` so far, summed over every turn.
  droppedTurns: number
  // SerpApi searches spent in this chat, failed turns included.
  searches: ChatSearches
  // The last turn's full responses, fetched once (see `measureLastTurn`).
  measured: {
    turnId: string
    results: Promise<Array<FullResponseResult>>
  } | null
  pending: { progressId: string; startedAt: number } | null
  touchedAt: number
}

const COOKIE = "local-llm-web-search.chat"
const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60
const MAX_SESSIONS = 20
const IDLE_MS = 24 * 60 * 60 * 1000

// Server-side ceiling on one turn, a guard against a hang only. It sits
// above the agent's own worst case: four completions at 300 s (480 s for
// Markdown Raw), load attempts at 60 s each, and the SerpApi calls.
const TURN_TIMEOUT_MS = { default: 30 * 60_000, "markdown-full": 45 * 60_000 }

const store = globalThis as typeof globalThis & {
  __chatSessions?: Map<string, SessionState>
}

function sessions(): Map<string, SessionState> {
  store.__chatSessions ??= new Map()
  return store.__chatSessions
}

/**
 * Drop sessions idle for a day, then the oldest beyond `keep`. A session
 * with a turn running is never dropped. Exported for tests.
 */
export function evictSessions(
  map: Map<string, { touchedAt: number; pending: unknown }>,
  now: number,
  keep = MAX_SESSIONS
): void {
  for (const [id, s] of map) {
    if (!s.pending && now - s.touchedAt > IDLE_MS) map.delete(id)
  }
  const oldestFirst = [...map.entries()]
    .filter(([, s]) => !s.pending)
    .sort((a, b) => a[1].touchedAt - b[1].touchedAt)
  for (const [id] of oldestFirst) {
    if (map.size <= keep) break
    map.delete(id)
  }
}

/** A fresh, unregistered session. Exported for tests. */
export function newSession(): SessionState {
  return {
    id: crypto.randomUUID(),
    messages: [],
    conversation: [],
    last: null,
    droppedTurns: 0,
    searches: { model: 0, compare: 0 },
    measured: null,
    pending: null,
    touchedAt: Date.now(),
  }
}

function adopt(s: SessionState): SessionState {
  s.touchedAt = Date.now()
  setCookie(COOKIE, s.id, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_S,
  })
  return s
}

function createSession(): SessionState {
  evictSessions(sessions(), Date.now())
  const s = newSession()
  sessions().set(s.id, s)
  return adopt(s)
}

/** The session the request's cookie names, or a new one. */
export function currentSession(): SessionState {
  // WHY: the response now depends on the cookie. No cache may keep it or
  //      hand it to another browser.
  setResponseHeader("Cache-Control", "private, no-store")
  const id = getCookie(COOKIE)
  const s = id ? sessions().get(id) : undefined
  if (!s) return createSession()
  s.touchedAt = Date.now()
  return s
}

/** Point the cookie at `id` (Undo after Clear chat), or start fresh if it is gone. */
export function switchSession(id: string): SessionState {
  // Switching away would hide the answer still being written.
  if (currentSession().pending) {
    throw new Error("Wait for the current answer before going back.")
  }
  const s = sessions().get(id)
  return s ? adopt(s) : createSession()
}

/** Start a fresh session. Returns it and the one it replaced, for Undo. */
export function replaceSession(): {
  session: SessionState
  previousId: string
} {
  const previousId = currentSession().id
  return { session: createSession(), previousId }
}

export function snapshot(
  s: SessionState,
  progress: (progressId: string) => QueryProgress | null = readQueryProgress
): ChatSession {
  return {
    id: s.id,
    messages: s.messages,
    pending: s.pending
      ? {
          startedAt: s.pending.startedAt,
          progress: progress(s.pending.progressId),
        }
      : null,
    last: s.last,
    turnsInMemory: s.conversation.filter((m) => m.role === "user").length,
    searches: { ...s.searches },
  }
}

/** SerpApi searches a turn's tool calls spent. Exported for tests. */
export function searchesIn(calls: Array<Pick<ToolCallInfo, "searches">>) {
  return calls.reduce((sum, c) => sum + (c.searches ?? 1), 0)
}

export function status(s: SessionState): ChatStatus {
  const { pending } = snapshot(s)
  return { id: s.id, pending, messageCount: s.messages.length }
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    handle = setTimeout(
      () =>
        reject(
          new Error(
            `The answer took longer than ${Math.round(ms / 60_000)} minutes. Try again, or pick a smaller or faster model.`
          )
        ),
      ms
    )
  })
  return Promise.race([work, timeout]).finally(() => clearTimeout(handle))
}

/**
 * Run one turn against `s`: the question shows up and the turn is pending
 * as soon as this is called, then the answer (or the error) lands in the
 * session when the agent finishes. Exported with an injectable runner for
 * tests.
 */
export async function runTurn(
  s: SessionState,
  input: ChatTurnInput,
  run: (data: RunQueryInput) => Promise<RunQueryResult> = runAgentTurn
): Promise<void> {
  if (s.pending)
    throw new Error("The model is still answering the last question.")
  const progressId = crypto.randomUUID()
  const startedAt = Date.now()
  s.pending = { progressId, startedAt }
  s.messages = [
    ...s.messages,
    { id: crypto.randomUUID(), role: "user", content: input.question },
  ]
  try {
    const result = await withTimeout(
      run({
        question: input.question,
        model: input.model,
        contextLength: input.contextLength,
        toolUseTrained: input.toolUseTrained,
        // The stored history came out of the agent itself; parsing it
        // again keeps the agent's input contract checked, not assumed.
        history: z.array(historyMessageSchema).parse(s.conversation),
        toolOutput: input.toolOutput,
        progressId,
      }),
      TURN_TIMEOUT_MS[
        input.toolOutput === "markdown-full" ? "markdown-full" : "default"
      ]
    )
    s.messages = [
      ...s.messages,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: result.answer,
        // WHY: on a failed turn `toolCalls` is an empty array, which would
        //      render a misleading "Direct answer" badge under the error.
        toolCalls: result.ok
          ? result.toolCalls.map(({ name, args, round }) => ({
              name,
              args,
              round,
            }))
          : undefined,
        sources: result.sources,
        elapsedMs: result.elapsedMs,
        phases: result.phases,
      },
    ]
    // A failed turn still spent the searches it ran before it failed.
    s.searches.model += searchesIn(result.toolCalls)
    if (result.ok) {
      s.droppedTurns += result.trimmedTurns
      s.last = {
        turnId: progressId,
        breakdown: result.breakdown,
        exactUsage: result.exactUsage,
        totalUsage: result.totalUsage,
        phases: result.phases,
        modelContext: {
          loaded: result.loadedContext ?? input.contextLength,
          max: input.maxContextLength,
        },
        trimmedTurns: s.droppedTurns,
        conversationTokens: result.conversationTokens,
        toolCalls: result.toolCalls,
        searches: searchesIn(result.toolCalls),
      }
    }
    // Unchanged on a failed turn, already trimmed on a good one.
    s.conversation = result.messages
  } catch (err) {
    s.messages = [
      ...s.messages,
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `**Error:** ${err instanceof Error ? err.message : String(err)}`,
        toolCalls: [],
        sources: [],
        elapsedMs: Date.now() - startedAt,
        isError: true,
      },
    ]
  } finally {
    s.pending = null
    s.touchedAt = Date.now()
  }
}

/** Start a turn in the background and return the session as it stands. */
export function sendMessage(input: ChatTurnInput): ChatSession {
  const s = currentSession()
  if (s.pending)
    throw new Error("The model is still answering the last question.")
  // Fire and forget: the request returns now, the turn keeps going.
  void runTurn(s, input)
  return snapshot(s)
}

/**
 * The last turn's full, unrestricted SerpApi responses, for the restrictor
 * card's before/after. Runs once per turn: each call is one more search,
 * counted in `searches.compare`, and a second request for the same turn
 * (another tab, a remount) gets the same results instead of searching
 * again. Exported with an injectable fetch for tests.
 */
export function measureLastTurn(
  s: SessionState,
  turnId: string,
  fetchFull: typeof fetchFullResponse = fetchFullResponse
): Promise<Array<FullResponseResult>> {
  if (s.measured?.turnId === turnId) return s.measured.results
  const calls = s.last?.turnId === turnId ? s.last.toolCalls : null
  if (!calls) {
    return Promise.reject(new Error("That turn is no longer the latest one."))
  }
  // WHY: nothing to compare when a call ran without a restrictor, or when
  //      Finance fell back to a web search: the unrestricted Finance call
  //      would answer a different question. Spend no searches on it.
  if (calls.some((c) => c.restrictor === null || (c.searches ?? 1) > 1)) {
    return Promise.resolve([])
  }
  const results = Promise.all(
    calls.map(async (c) => {
      const full = await fetchFull({
        name: c.name,
        args: c.args,
        output: c.output,
      })
      s.searches.compare += 1
      return full
    })
  )
  s.measured = { turnId, results }
  // A failed measurement may run again.
  results.catch(() => {
    if (s.measured?.results === results) s.measured = null
  })
  return results
}
