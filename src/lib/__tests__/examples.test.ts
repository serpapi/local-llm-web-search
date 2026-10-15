import { afterEach, describe, expect, it, vi } from "vitest"

import { payloadCalls } from "../bench"
import { buildExamples, exampleTripDates } from "../examples"

afterEach(() => {
  vi.useRealTimers()
})

describe("exampleTripDates", () => {
  it("adds two months and three nights in UTC", () => {
    // New Year's Eve in most of the Americas, already January 1 in UTC.
    vi.useFakeTimers({ now: new Date("2027-01-01T01:00:00Z") })
    expect(exampleTripDates()).toEqual({
      checkIn: "2027-03-01",
      checkOut: "2027-03-04",
    })
  })

  it("gives the examples and the payload tier the same trip", () => {
    vi.useFakeTimers({ now: new Date("2027-01-01T01:00:00Z") })
    const questions = buildExamples().flatMap((g) =>
      g.items.map((i) => i.question)
    )
    const hotels = payloadCalls().find((c) => c.label === "Hotels")
    expect(questions).toContain(
      "Hotels in Barcelona from 2027-03-01 to 2027-03-04 for 2 adults"
    )
    expect(hotels?.args).toMatchObject({
      check_in_date: "2027-03-01",
      check_out_date: "2027-03-04",
    })
  })
})
