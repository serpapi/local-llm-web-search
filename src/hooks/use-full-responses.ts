import { useQueryClient } from "@tanstack/react-query"
import { useRef, useState } from "react"

import type { FullResponseResult, ToolCallInfo } from "@/lib/agent-types"
import type { ChatSession, ChatTurnStats } from "@/lib/chat"
import { chatQueries, measureFullResponses } from "@/server/chat"

// The full (unrestricted) SerpApi responses for the latest turn, shared by
// the breakdown card's before/after and the inspect dialog's raw view.
// `results` is aligned by index with the turn's tool calls.
export type FullFetchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "done"; results: Array<FullResponseResult> }

const IDLE: FullFetchState = { status: "idle" }

function toolCallKeyOf(calls: Array<ToolCallInfo>): string {
  return calls
    .map((c) => `${c.name}:${c.output}:${JSON.stringify(c.args)}`)
    .join("|")
}

// A Finance call that found no quote falls back to google_search, so its
// response no longer matches what an unrestricted Finance call would
// return. Comparing the two would be apples-to-oranges, so we skip the
// before/after for it.
function isFallbackResponse(call: ToolCallInfo): boolean {
  // Markdown mode prefixes the fallback with a blockquote note.
  if (typeof call.response === "string") {
    return call.response.startsWith("> Google Finance had no direct quote")
  }
  return (
    call.response != null &&
    typeof call.response === "object" &&
    !Array.isArray(call.response) &&
    "fallback_from" in call.response
  )
}

/**
 * Whether a turn that just ended gets its full responses fetched, at one
 * SerpApi search per tool call: only when this page watched it run, it
 * succeeded, and it was not measured yet. The server replaces `last` only
 * on success, so a failed turn comes back with the previous turn's id.
 */
export function shouldMeasureTurn({
  before,
  after,
  watched,
  measured,
}: {
  before: ChatTurnStats | null
  after: ChatTurnStats | null
  watched: boolean
  measured: ReadonlySet<string>
}): boolean {
  if (!watched || after === null) return false
  const key = after.turnId
  if (measured.has(key)) return false
  return before === null || before.turnId !== key
}

/**
 * The full responses for the turn whose tool calls are on screen.
 * WHY: fetched once, when a turn ends on this page. A turn restored from
 *      the session (reload, Back, Undo) shows without them, because
 *      fetching again would spend SerpApi credits on a comparison already
 *      seen. Undo right after Clear still finds them here.
 */
export function useFullResponses(toolCalls: Array<ToolCallInfo>) {
  const queryClient = useQueryClient()
  const [fetched, setFetched] = useState<{
    key: string
    state: FullFetchState
  } | null>(null)
  const measured = useRef(new Set<string>())
  const toolCallKey = toolCallKeyOf(toolCalls)
  const fullFetch = fetched?.key === toolCallKey ? fetched.state : IDLE

  function measureTurn(turn: {
    before: ChatTurnStats | null
    after: ChatTurnStats | null
    watched: boolean
  }) {
    const { after } = turn
    if (!after || !shouldMeasureTurn({ ...turn, measured: measured.current })) {
      return
    }
    measured.current.add(after.turnId)
    const calls = after.toolCalls
    if (
      calls.length === 0 ||
      calls.some(isFallbackResponse) ||
      // No restrictor ran, so the response the model got already is the
      // full one, nothing to compare against.
      calls.some((c) => c.restrictor === null)
    ) {
      return
    }
    const key = toolCallKeyOf(calls)
    const settle = (state: FullFetchState) =>
      setFetched((prev) => (prev?.key === key ? { key, state } : prev))
    setFetched({ key, state: { status: "loading" } })
    measureFullResponses({ data: { turnId: after.turnId } })
      .then(({ results, searches }) => {
        // The searches it spent show in the sidebar's count right away.
        queryClient.setQueryData(
          chatQueries.session().queryKey,
          (old: ChatSession | undefined) => old && { ...old, searches }
        )
        settle(results.length > 0 ? { status: "done", results } : IDLE)
      })
      .catch((err: unknown) =>
        settle({
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        })
      )
  }

  return { fullFetch, measureTurn }
}
