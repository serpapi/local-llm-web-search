import { useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"

import type { FullResponseResult, ToolCallInfo } from "@/lib/agent-types"
import type { ChatSession } from "@/lib/chat"
import { chatQueries, measureFullResponses } from "@/server/chat.functions"

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
 * Whether a turn's tool calls can be compared with their full responses:
 * every call ran a restrictor and none fell back to another engine.
 * Exported for tests.
 */
export function canCompare(calls: Array<ToolCallInfo>): boolean {
  return (
    calls.length > 0 &&
    !calls.some(isFallbackResponse) &&
    // No restrictor ran, so the response the model got already is the
    // full one, nothing to compare against.
    calls.every((c) => c.restrictor !== null)
  )
}

/**
 * The full responses for the turn whose tool calls are on screen, fetched
 * when the user asks for them.
 * WHY: the comparison runs each search again without the restrictor, at
 *      one SerpApi search per tool call. Run after every answer, it
 *      doubled what a chat spent, so it waits for a click.
 */
export function useFullResponses(
  turnId: string | null,
  toolCalls: Array<ToolCallInfo>,
  // The turn the server already measured, from the session.
  measuredTurnId: string | null
) {
  const queryClient = useQueryClient()
  const [fetched, setFetched] = useState<{
    key: string
    state: FullFetchState
  } | null>(null)

  // Keyed by turn too: two turns can make the same tool call.
  const key = `${turnId ?? ""}|${toolCallKeyOf(toolCalls)}`
  const fullFetch = fetched?.key === key ? fetched.state : IDLE
  const canMeasure = turnId !== null && canCompare(toolCalls)

  function measure(cachedOnly = false) {
    if (!canMeasure) return
    if (fullFetch.status === "loading" || fullFetch.status === "done") return
    const settle = (state: FullFetchState) =>
      setFetched((prev) => (prev?.key === key ? { key, state } : prev))
    setFetched({ key, state: { status: "loading" } })
    measureFullResponses({
      data: cachedOnly ? { turnId, cachedOnly } : { turnId },
    })
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

  // A comparison the server already holds (say, before a reload) costs no
  // search, so it loads without a click. Cache only: if that measurement
  // failed in the meantime, nothing new runs.
  useEffect(() => {
    if (measuredTurnId !== null && measuredTurnId === turnId) measure(true)
  }, [measuredTurnId, turnId])

  return { fullFetch, canMeasure, measure: () => measure() }
}
