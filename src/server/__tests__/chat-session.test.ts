import { describe, expect, it } from "vitest"

import {
  cachedMeasurement,
  evictSessions,
  measureLastTurn,
  newSession,
  runTurn,
  searchesIn,
  snapshot,
} from "../chat-session.server"
import type { RunQueryInput, RunQueryResult } from "../agent.server"
import type { ChatTurnInput } from "@/lib/chat"
import type { ToolCallInfo } from "@/lib/agent-types"

const input: ChatTurnInput = {
  question: "What is 2+2?",
  model: "qwen/qwen3.8-27b",
  contextLength: 32768,
  maxContextLength: 262144,
  toolUseTrained: true,
  toolOutput: "markdown",
}

const ok = (over: Partial<RunQueryResult> = {}): RunQueryResult =>
  ({
    ok: true,
    answer: "4",
    breakdown: {
      tool_definitions: 1,
      system_prompt: 1,
      conversation_history: 0,
      user_message: 1,
      tool_call: 0,
      tool_result: 0,
      final_response: 1,
    },
    exactUsage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    totalUsage: null,
    toolCalls: [],
    sources: [],
    elapsedMs: 900,
    phases: { firstInferenceMs: 1, toolExecutionMs: 0, secondInferenceMs: 0 },
    messages: [
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4" },
    ],
    trimmedTurns: 0,
    conversationTokens: 50,
    loadedContext: 32768,
    appliedContext: 61696,
    retried: false,
    cutOff: false,
    answerMissing: false,
    toolRounds: 0,
    rawReply: null,
    ...over,
  }) as RunQueryResult

const noProgress = () => null

describe("runTurn", () => {
  it("shows the question and a pending turn before the model answers", async () => {
    const s = newSession()
    let release: (r: RunQueryResult) => void = () => {}
    const done = runTurn(
      s,
      input,
      () => new Promise<RunQueryResult>((r) => (release = r))
    )
    const during = snapshot(s, noProgress)
    expect(during.messages.map((m) => m.role)).toEqual(["user"])
    expect(during.pending).not.toBeNull()
    release(ok())
    await done
    const after = snapshot(s, noProgress)
    expect(after.pending).toBeNull()
    expect(after.messages.map((m) => [m.role, m.content])).toEqual([
      ["user", "What is 2+2?"],
      ["assistant", "4"],
    ])
    expect(after.turnsInMemory).toBe(1)
    expect(after.last?.modelContext).toEqual({ loaded: 32768, max: 262144 })
  })

  it("passes the stored history to the next turn", async () => {
    const s = newSession()
    await runTurn(s, input, () => Promise.resolve(ok()))
    let seen: RunQueryInput | undefined
    await runTurn(s, { ...input, question: "And 3+3?" }, (data) => {
      seen = data
      return Promise.resolve(ok())
    })
    expect(seen?.history).toHaveLength(2)
    expect(seen?.question).toBe("And 3+3?")
  })

  it("keeps the last good numbers when a turn fails", async () => {
    const s = newSession()
    await runTurn(s, input, () => Promise.resolve(ok()))
    const before = s.last
    await runTurn(s, input, () =>
      Promise.resolve(ok({ ok: false, answer: "**Error:** LM Studio is down" }))
    )
    expect(s.last).toBe(before)
    expect(s.messages.at(-1)?.content).toBe("**Error:** LM Studio is down")
    expect(s.messages.at(-1)?.toolCalls).toBeUndefined()
  })

  it("adds up the turns dropped to fit across the conversation", async () => {
    const s = newSession()
    await runTurn(s, input, () => Promise.resolve(ok({ trimmedTurns: 2 })))
    await runTurn(s, input, () => Promise.resolve(ok({ trimmedTurns: 1 })))
    expect(s.last?.trimmedTurns).toBe(3)
  })

  it("turns a thrown error into an error message and clears the pending turn", async () => {
    const s = newSession()
    await runTurn(s, input, () => Promise.reject(new Error("socket hang up")))
    expect(s.pending).toBeNull()
    expect(s.messages.at(-1)).toMatchObject({
      role: "assistant",
      isError: true,
      content: "**Error:** socket hang up",
    })
  })

  it("rejects a second question while one is running", async () => {
    const s = newSession()
    const first = runTurn(s, input, () => new Promise(() => {}))
    await expect(
      runTurn(s, input, () => Promise.resolve(ok()))
    ).rejects.toThrow(/still answering/)
    void first
  })
})

describe("runTurn payloads", () => {
  it("keeps tool responses for the sidebar only, not in every message", async () => {
    const call = {
      name: "google_search",
      args: { query: "Apple CEO" },
      restrictor: null,
      output: "markdown-full" as const,
      response: "# 10,000 tokens of Markdown",
      tokens: 10000,
      serpApiMs: 80,
    }
    const s = newSession()
    await runTurn(s, input, () => Promise.resolve(ok({ toolCalls: [call] })))
    expect(s.messages.at(-1)?.toolCalls).toEqual([
      { name: "google_search", args: { query: "Apple CEO" } },
    ])
    expect(s.last?.toolCalls[0].response).toBe("# 10,000 tokens of Markdown")
  })
})

describe("evictSessions", () => {
  it("drops idle sessions and the oldest past the cap, never a running one", () => {
    const now = 1_000_000_000
    const day = 24 * 60 * 60 * 1000
    const map = new Map([
      ["idle", { touchedAt: now - 2 * day, pending: null }],
      ["running", { touchedAt: now - 2 * day, pending: { startedAt: now } }],
      ["old", { touchedAt: now - 3000, pending: null }],
      ["new", { touchedAt: now - 1000, pending: null }],
    ])
    evictSessions(map, now, 2)
    expect([...map.keys()].sort()).toEqual(["new", "running"])
  })
})

const search = (over: Partial<ToolCallInfo> = {}): ToolCallInfo => ({
  name: "google_search",
  args: { query: "SerpApi pricing" },
  restrictor: "organic_results[0:5].{title,link}",
  output: "markdown",
  response: "## Organic Results",
  tokens: 200,
  serpApiMs: 900,
  round: 1,
  searches: 1,
  ...over,
})

describe("SerpApi search count", () => {
  it("counts a Finance fallback as two searches", () => {
    expect(searchesIn([search(), search({ searches: 2 }), {}])).toBe(4)
  })

  it("adds every turn's searches to the chat, failed turns included", async () => {
    const s = newSession()
    await runTurn(s, input, () =>
      Promise.resolve(ok({ toolCalls: [search(), search({ round: 2 })] }))
    )
    expect(s.last?.searches).toBe(2)
    await runTurn(s, input, () =>
      Promise.resolve(
        ok({ ok: false, answer: "**Error:** parse", toolCalls: [search()] })
      )
    )
    expect(snapshot(s, noProgress).searches).toEqual({ model: 3, compare: 0 })
    // The sidebar keeps the last good turn's count.
    expect(s.last?.searches).toBe(2)
  })
})

describe("measureLastTurn", () => {
  const full = {
    response: "## Organic Results\n...",
    tokens: 9000,
    serpApiMs: 1200,
  }

  async function sessionWith(calls: Array<ToolCallInfo>) {
    const s = newSession()
    await runTurn(s, input, () => Promise.resolve(ok({ toolCalls: calls })))
    return s
  }

  it("runs each call once and counts the searches", async () => {
    const s = await sessionWith([search(), search()])
    let fetched = 0
    const fetchFull = () => {
      fetched++
      return Promise.resolve(full)
    }
    const turnId = s.last?.turnId ?? ""
    await expect(measureLastTurn(s, turnId, fetchFull)).resolves.toHaveLength(2)
    // A second request for the same turn spends nothing.
    await measureLastTurn(s, turnId, fetchFull)
    expect(fetched).toBe(2)
    expect(s.searches).toEqual({ model: 2, compare: 2 })
  })

  it("reads a held measurement back without starting one", async () => {
    const s = await sessionWith([search()])
    const turnId = s.last?.turnId ?? ""
    await expect(cachedMeasurement(s, turnId)).resolves.toEqual([])
    expect(s.searches.compare).toBe(0)
    await measureLastTurn(s, turnId, () => Promise.resolve(full))
    await expect(cachedMeasurement(s, turnId)).resolves.toHaveLength(1)
    expect(s.searches.compare).toBe(1)
  })

  it("spends nothing on a turn it can't compare", async () => {
    const fetchFull = () => Promise.reject(new Error("must not run"))
    for (const call of [
      search({ restrictor: null }),
      search({ name: "google_finance_search", searches: 2 }),
    ]) {
      const s = await sessionWith([call])
      await expect(
        measureLastTurn(s, s.last?.turnId ?? "", fetchFull)
      ).resolves.toEqual([])
      expect(s.searches.compare).toBe(0)
    }
  })

  it("compares a search that also fetched its AI Overview", async () => {
    const s = await sessionWith([search({ searches: 2 })])
    await expect(
      measureLastTurn(s, s.last?.turnId ?? "", () => Promise.resolve(full))
    ).resolves.toHaveLength(1)
    expect(s.searches).toEqual({ model: 2, compare: 1 })
  })

  it("refuses a turn that is no longer the latest", async () => {
    const s = await sessionWith([search()])
    await expect(
      measureLastTurn(s, "turn-gone", () => Promise.resolve(full))
    ).rejects.toThrow(/no longer the latest/)
  })
})
