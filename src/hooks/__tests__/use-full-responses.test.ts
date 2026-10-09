import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"

import { shouldMeasureTurn, useFullResponses } from "../use-full-responses"

import type { ReactNode } from "react"
import type { ToolCallInfo } from "@/lib/agent-types"
import type { ChatSession, ChatTurnStats } from "@/lib/chat"

// Every call here would spend SerpApi searches for real.
const measureFullResponses = vi.hoisted(() => vi.fn())
const SESSION_KEY = ["chat", "session"]
vi.mock("@/server/chat", () => ({
  measureFullResponses,
  chatQueries: { session: () => ({ queryKey: SESSION_KEY }) },
}))

let queryClient: QueryClient
const wrapper = ({ children }: { children: ReactNode }) =>
  createElement(QueryClientProvider, { client: queryClient }, children)

const call = (query: string): ToolCallInfo => ({
  name: "google_search",
  args: { query },
  restrictor: "organic_results[0:5].{title,link}",
  output: "json",
  response: { organic_results: [] },
  tokens: 120,
  serpApiMs: 800,
})

const stats = (calls: Array<ToolCallInfo>, turnId: string): ChatTurnStats => ({
  turnId,
  breakdown: {
    tool_definitions: 1,
    system_prompt: 1,
    conversation_history: 0,
    user_message: 1,
    tool_call: 1,
    tool_result: 1,
    final_response: 1,
  },
  exactUsage: null,
  totalUsage: null,
  phases: {
    firstInferenceMs: 900,
    toolExecutionMs: 800,
    secondInferenceMs: 1200,
  },
  modelContext: { loaded: 32768, max: 32768 },
  trimmedTurns: 0,
  conversationTokens: 500,
  toolCalls: calls,
  searches: calls.length,
})

// The server sends a fresh copy of the session each time, so a turn that
// failed comes back as an equal object, never the same one.
const copy = (s: ChatTurnStats): ChatTurnStats => structuredClone(s)

describe("shouldMeasureTurn", () => {
  const none = new Set<string>()
  const earlier = stats([call("bitcoin")], "turn-700")
  const latest = stats([call("weather in Paris")], "turn-950")

  it("measures a turn this page watched succeed", () => {
    expect(
      shouldMeasureTurn({
        before: earlier,
        after: latest,
        watched: true,
        measured: none,
      })
    ).toBe(true)
    expect(
      shouldMeasureTurn({
        before: null,
        after: latest,
        watched: true,
        measured: none,
      })
    ).toBe(true)
  })

  it("skips a failed turn, which leaves the previous stats in place", () => {
    expect(
      shouldMeasureTurn({
        before: earlier,
        after: copy(earlier),
        watched: true,
        measured: none,
      })
    ).toBe(false)
    expect(
      shouldMeasureTurn({
        before: null,
        after: null,
        watched: true,
        measured: none,
      })
    ).toBe(false)
  })

  it("skips a turn that had already ended when the page loaded", () => {
    expect(
      shouldMeasureTurn({
        before: earlier,
        after: latest,
        watched: false,
        measured: none,
      })
    ).toBe(false)
  })

  it("tells apart two turns that made the same tool call", () => {
    const again = stats([call("bitcoin")], "turn-650")
    expect(
      shouldMeasureTurn({
        before: earlier,
        after: again,
        watched: true,
        measured: none,
      })
    ).toBe(true)
  })
})

describe("useFullResponses", () => {
  const full = {
    response: { organic_results: [] },
    tokens: 4000,
    serpApiMs: 1500,
  }
  beforeEach(() => {
    queryClient = new QueryClient()
    measureFullResponses.mockReset()
    measureFullResponses.mockResolvedValue({
      results: [full, full],
      searches: { model: 2, compare: 2 },
    })
  })

  it("measures a new successful turn once and shows its searches", async () => {
    queryClient.setQueryData(SESSION_KEY, {
      searches: { model: 2, compare: 0 },
    } as ChatSession)
    const before = stats([call("bitcoin")], "turn-700")
    const after = stats([call("paris"), call("rome")], "turn-950")
    const { result, rerender } = renderHook(
      ({ calls }) => useFullResponses(calls),
      { initialProps: { calls: before.toolCalls }, wrapper }
    )
    act(() => result.current.measureTurn({ before, after, watched: true }))
    rerender({ calls: after.toolCalls })
    await waitFor(() => expect(result.current.fullFetch.status).toBe("done"))
    expect(measureFullResponses).toHaveBeenCalledTimes(1)
    expect(measureFullResponses).toHaveBeenCalledWith({
      data: { turnId: "turn-950" },
    })
    expect(
      queryClient.getQueryData<ChatSession>(SESSION_KEY)?.searches
    ).toEqual({ model: 2, compare: 2 })

    // The same turn seen again, by a second poll or after Undo.
    act(() =>
      result.current.measureTurn({
        before: null,
        after: copy(after),
        watched: true,
      })
    )
    expect(measureFullResponses).toHaveBeenCalledTimes(1)
  })

  it("does not refetch the previous turn when a turn fails", () => {
    const before = stats([call("bitcoin")], "turn-700")
    const { result } = renderHook(() => useFullResponses(before.toolCalls), {
      wrapper,
    })
    act(() =>
      result.current.measureTurn({ before, after: copy(before), watched: true })
    )
    expect(measureFullResponses).not.toHaveBeenCalled()
    expect(result.current.fullFetch.status).toBe("idle")
  })

  it("does not fetch a turn the page did not watch", () => {
    const after = stats([call("paris")], "turn-950")
    const { result } = renderHook(() => useFullResponses(after.toolCalls), {
      wrapper,
    })
    act(() =>
      result.current.measureTurn({ before: null, after, watched: false })
    )
    expect(measureFullResponses).not.toHaveBeenCalled()
  })

  it("keeps the error message when the fetch fails", async () => {
    measureFullResponses.mockRejectedValue(new Error("Invalid API key."))
    const after = stats([call("paris")], "turn-950")
    const { result } = renderHook(() => useFullResponses(after.toolCalls), {
      wrapper,
    })
    act(() =>
      result.current.measureTurn({ before: null, after, watched: true })
    )
    await waitFor(() =>
      expect(result.current.fullFetch).toEqual({
        status: "error",
        message: "Invalid API key.",
      })
    )
  })
})
