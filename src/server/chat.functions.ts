// Chat server functions. The conversation lives on the server in
// `chat-session.server.ts`; these are the page's only way in. Only the
// handlers use that module, so the client build, which replaces each
// handler with an RPC stub, drops the import with them.

import { queryOptions } from "@tanstack/react-query"
import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import {
  cachedMeasurement,
  currentSession,
  measureLastTurn,
  replaceSession,
  sendMessage,
  snapshot,
  status,
  switchSession,
} from "./chat-session.server"
import type { ChatSearches, ChatSession, ChatStatus } from "@/lib/chat"
import type { FullResponseResult } from "@/lib/agent-types"
import { chatTurnInput } from "@/lib/chat"

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

/**
 * The last turn's full SerpApi responses, for the restrictor card's
 * before/after. One search per tool call, once per turn; returns the
 * chat's updated search count with them. With `cachedOnly`, it returns
 * only what the server already holds and spends nothing.
 */
export const measureFullResponses = createServerFn({ method: "POST" })
  .validator(
    z.object({
      turnId: z.string().min(1).max(100),
      cachedOnly: z.boolean().optional(),
    })
  )
  .handler(
    async ({
      data,
    }): Promise<{
      results: Array<FullResponseResult>
      searches: ChatSearches
    }> => {
      const s = currentSession()
      const results = await (data.cachedOnly
        ? cachedMeasurement(s, data.turnId)
        : measureLastTurn(s, data.turnId))
      return { results, searches: { ...s.searches } }
    }
  )

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
