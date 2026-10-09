// Chat server functions. The conversation lives on the server in
// `chat-session.server.ts`; these are the page's only way in. Only the
// handlers use that module, so the client build, which replaces each
// handler with an RPC stub, drops the import with them.

import { queryOptions } from "@tanstack/react-query"
import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import {
  currentSession,
  replaceSession,
  sendMessage,
  snapshot,
  status,
  switchSession,
} from "./chat-session.server"
import type { ChatSession, ChatStatus } from "@/lib/chat"
import { TOOL_OUTPUTS } from "@/lib/agent-types"

export const chatTurnInput = z.object({
  question: z.string().trim().min(1).max(4000),
  model: z.string().min(1),
  contextLength: z.number().int().positive(),
  maxContextLength: z.number().int().positive(),
  toolUseTrained: z.boolean().optional(),
  toolOutput: z.enum(TOOL_OUTPUTS),
})

export type ChatTurnInput = z.infer<typeof chatTurnInput>

/** The browser's chat session, created on first visit. */
export const getChatSession = createServerFn({ method: "GET" }).handler(
  (): ChatSession => {
    return snapshot(currentSession())
  }
)

/** Whether a turn is running and how far it got. Cheap enough to poll. */
export const getChatStatus = createServerFn({ method: "GET" }).handler(
  (): ChatStatus => {
    return status(currentSession())
  }
)

/** Ask a question. Returns at once; the answer arrives in the session. */
export const sendChatMessage = createServerFn({ method: "POST" })
  .validator(chatTurnInput)
  .handler(({ data }): ChatSession => {
    return sendMessage(data)
  })

/** Start an empty chat. Returns the old session's id so Clear can be undone. */
export const clearChatSession = createServerFn({ method: "POST" }).handler(
  (): { session: ChatSession; previousId: string } => {
    const { session, previousId } = replaceSession()
    return { session: snapshot(session), previousId }
  }
)

/** Go back to an earlier session (Undo after Clear chat). */
export const restoreChatSession = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(({ data }): ChatSession => {
    return snapshot(switchSession(data.id))
  })

// The page reads the session through TanStack Query. The route loader fills
// the cache, the mutations write the session each server function returns,
// and the status query polls while a turn runs.
export const chatQueries = {
  all: ["chat"] as const,
  session: () =>
    queryOptions({
      queryKey: [...chatQueries.all, "session"] as const,
      queryFn: ({ signal }) => getChatSession({ signal }),
    }),
  /** Keyed by turn, so a new turn never starts from the last one's status. */
  status: (sessionId: string, startedAt: number | null) =>
    queryOptions({
      queryKey: [...chatQueries.all, "status", sessionId, startedAt] as const,
      queryFn: ({ signal }) => getChatStatus({ signal }),
      staleTime: 0,
    }),
}
