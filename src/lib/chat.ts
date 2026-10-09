// Browser-safe shapes for the server-side chat session. The conversation
// lives on the server (`src/server/chat-session.server.ts`) so a reload, a
// closed tab or an HMR update never loses it; the page renders these.

import type {
  Breakdown,
  ExactUsage,
  Phases,
  QueryProgress,
  Source,
  ToolCallInfo,
} from "@/lib/agent-types"

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

// The sidebar's numbers, from the last turn that succeeded. A failed turn
// leaves them as they were, so the context never looks wiped when it wasn't.
export type ChatTurnStats = {
  // Names the turn, so the page can tell a new turn from a failed one.
  turnId: string
  breakdown: Breakdown
  exactUsage: ExactUsage | null
  phases: Phases
  modelContext: ModelContextSnapshot
  trimmedTurns: number
  conversationTokens: number
  toolCalls: Array<ToolCallInfo>
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
}

// What the page polls while a turn runs: small on purpose, because the full
// session carries every tool response of the conversation.
export type ChatStatus = {
  id: string
  pending: ChatPending | null
  messageCount: number
}
