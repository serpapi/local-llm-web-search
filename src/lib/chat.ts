// Browser-safe shapes for the server-side chat session. The conversation
// lives on the server (`src/server/chat-session.server.ts`) so a reload, a
// closed tab or an HMR update never loses it; the page renders these.

import { z } from "zod"

import type {
  Breakdown,
  ExactUsage,
  Phases,
  QueryProgress,
  Source,
  ToolCallInfo,
} from "@/lib/agent-types"
import { TOOL_OUTPUTS } from "@/lib/agent-types"

/** A question for the agent. `sendChatMessage` validates it. */
export const chatTurnInput = z.object({
  question: z.string().trim().min(1).max(4000),
  model: z.string().min(1),
  contextLength: z.number().int().positive(),
  maxContextLength: z.number().int().positive(),
  toolUseTrained: z.boolean().optional(),
  toolOutput: z.enum(TOOL_OUTPUTS),
})

export type ChatTurnInput = z.infer<typeof chatTurnInput>

// What a message needs to show its tool badges. The full responses stay on
// `ChatTurnStats.toolCalls`, for the last turn only: kept on every message
// they would grow the session by up to 60k tokens a turn.
export type ToolCallSummary = Pick<ToolCallInfo, "name" | "args" | "round">

export type ChatMessage = {
  id: string
  role: "user" | "assistant"
  content: string
  toolCalls?: Array<ToolCallSummary>
  sources?: Array<Source>
  elapsedMs?: number
  phases?: Phases
  isError?: boolean
}

// How big the model's usable context was when the turn ran, so the sidebar
// can show "tokens used / budget loaded" even after the model changes.
export type ModelContextSnapshot = {
  // The context LM Studio loaded this turn, or the requested size when no
  // load was confirmed.
  loaded: number
  // maxContextLength, the model's theoretical ceiling.
  max: number
}

// SerpApi searches a chat has spent, for the sidebar. `model` counts the
// searches the model asked for, `compare` the extra ones that measure the
// full, unrestricted response. Each costs a SerpApi credit unless SerpApi
// serves it from its one-hour cache.
export type ChatSearches = {
  model: number
  compare: number
}

// The sidebar's numbers, from the last turn that succeeded. A failed turn
// leaves them as they were, so the context never looks wiped when it wasn't.
export type ChatTurnStats = {
  // Names the turn, so the page can tell a new turn from a failed one.
  turnId: string
  // The LM Studio model that answered. Missing on sessions from before
  // it was recorded.
  model?: string
  breakdown: Breakdown
  exactUsage: ExactUsage | null
  // Every completion of the turn summed, or null if one lacked usage.
  totalUsage: (ExactUsage & { completions: number }) | null
  phases: Phases
  modelContext: ModelContextSnapshot
  trimmedTurns: number
  conversationTokens: number
  toolCalls: Array<ToolCallInfo>
  // SerpApi searches the model's tool calls spent this turn.
  searches: number
}

export type ChatPending = {
  startedAt: number
  progress: QueryProgress | null
}

export type ChatSession = {
  id: string
  messages: Array<ChatMessage>
  pending: ChatPending | null
  last: ChatTurnStats | null
  // User turns the model still remembers after history trimming.
  turnsInMemory: number
  searches: ChatSearches
  // The turn whose full responses the server holds, so the page can show
  // that comparison again without spending a search.
  measuredTurnId: string | null
}

// What the page polls while a turn runs: small on purpose, because the full
// session carries every tool response of the conversation.
export type ChatStatus = {
  id: string
  pending: ChatPending | null
  messageCount: number
}
