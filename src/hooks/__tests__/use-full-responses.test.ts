import { createElement } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"

import { canCompare, useFullResponses } from "../use-full-responses"

import type { ReactNode } from "react"
import type { ToolCallInfo } from "@/lib/agent-types"
import type { ChatSession } from "@/lib/chat"

// Every call here would spend SerpApi searches for real.
const measureFullResponses = vi.hoisted(() => vi.fn())
const SESSION_KEY = ["chat", "session"]
vi.mock("@/server/chat.functions", () => ({
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

describe("canCompare", () => {
  it("compares restricted calls", () => {
    expect(canCompare([call("paris"), call("rome")])).toBe(true)
  })

  it("skips a turn without tool calls", () => {
    expect(canCompare([])).toBe(false)
  })

  it("skips calls that ran without a restrictor", () => {
    expect(canCompare([{ ...call("paris"), restrictor: null }])).toBe(false)
  })

  it("skips a Finance call that fell back to web search", () => {
    const fallback: ToolCallInfo = {
      ...call("AAPL"),
      name: "google_finance_search",
      response: { fallback_from: "google_finance_search" },
    }
    expect(canCompare([fallback])).toBe(false)
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

  it("fetches nothing until asked", () => {
    const { result } = renderHook(
      () => useFullResponses("turn-950", [call("paris")], null),
      { wrapper }
    )
    expect(result.current.canMeasure).toBe(true)
    expect(result.current.fullFetch.status).toBe("idle")
    expect(measureFullResponses).not.toHaveBeenCalled()
  })

  it("measures once when asked and shows its searches", async () => {
    queryClient.setQueryData(SESSION_KEY, {
      searches: { model: 2, compare: 0 },
    } as ChatSession)
    const { result } = renderHook(
      () => useFullResponses("turn-950", [call("paris"), call("rome")], null),
      { wrapper }
    )
    act(() => result.current.measure())
    await waitFor(() => expect(result.current.fullFetch.status).toBe("done"))
    expect(measureFullResponses).toHaveBeenCalledTimes(1)
    expect(measureFullResponses).toHaveBeenCalledWith({
      data: { turnId: "turn-950" },
    })
    expect(
      queryClient.getQueryData<ChatSession>(SESSION_KEY)?.searches
    ).toEqual({ model: 2, compare: 2 })

    // A second click on a measured turn spends nothing.
    act(() => result.current.measure())
    expect(measureFullResponses).toHaveBeenCalledTimes(1)
  })

  it("loads a comparison the server already holds without a click", async () => {
    const { result } = renderHook(
      () => useFullResponses("turn-950", [call("paris")], "turn-950"),
      { wrapper }
    )
    await waitFor(() => expect(result.current.fullFetch.status).toBe("done"))
    expect(measureFullResponses).toHaveBeenCalledWith({
      data: { turnId: "turn-950", cachedOnly: true },
    })
  })

  it("starts over for a new turn with the same tool call", async () => {
    const { result, rerender } = renderHook(
      ({ turnId }) => useFullResponses(turnId, [call("paris")], null),
      { initialProps: { turnId: "turn-700" }, wrapper }
    )
    act(() => result.current.measure())
    await waitFor(() => expect(result.current.fullFetch.status).toBe("done"))
    rerender({ turnId: "turn-950" })
    expect(result.current.fullFetch.status).toBe("idle")
  })

  it("does nothing without a turn or a restrictor", () => {
    const noTurn = renderHook(
      () => useFullResponses(null, [call("paris")], null),
      {
        wrapper,
      }
    )
    act(() => noTurn.result.current.measure())
    const unrestricted = renderHook(
      () =>
        useFullResponses(
          "turn-950",
          [{ ...call("paris"), restrictor: null }],
          null
        ),
      { wrapper }
    )
    act(() => unrestricted.result.current.measure())
    expect(measureFullResponses).not.toHaveBeenCalled()
  })

  it("keeps the error message when the fetch fails", async () => {
    measureFullResponses.mockRejectedValue(new Error("Invalid API key."))
    const { result } = renderHook(
      () => useFullResponses("turn-950", [call("paris")], null),
      { wrapper }
    )
    act(() => result.current.measure())
    await waitFor(() =>
      expect(result.current.fullFetch).toEqual({
        status: "error",
        message: "Invalid API key.",
      })
    )
  })
})
