// Verify each `RESTRICTORS` string against live SerpApi: fire the
// matching query with the restrictor applied, dump the response to
// `measurements/raw-samples/<engine>-restricted.json`, and report:
//
//   - byte size (raw fixture → restricted response)
//   - top-level keys present after restriction
//   - a ✓/✗ against each formatter-expected field path
//
// Run this whenever you edit `src/server/restrictors.ts` so syntax
// mistakes show up locally instead of as failed benchmark runs. Costs
// one SerpApi credit per engine.

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { getJson, config as serpApiConfig } from "serpapi"

import { RESTRICTORS } from "../src/server/restrictors"

const OUT_DIR = resolve(
  import.meta.dirname,
  "..",
  "measurements",
  "raw-samples"
)

type Probe = {
  tool: keyof typeof RESTRICTORS
  rawFixture: string
  outFile: string
  params: Record<string, unknown>
  // Field paths the matching formatter reads. Each entry is a jq-style
  // path with `[*]` standing in for any array index. Verification passes
  // when the restricted response contains at least one non-empty leaf
  // for every listed path.
  formatterPaths: Array<string>
}

const PROBES: Array<Probe> = [
  {
    tool: "google_search",
    rawFixture: "google-entity-bare.json",
    outFile: "google-entity-bare-restricted.json",
    params: { engine: "google", q: "Linus Torvalds", num: 5 },
    formatterPaths: [
      "knowledge_graph.title",
      "knowledge_graph.type",
      "knowledge_graph.description",
      "knowledge_graph.source.link",
      "organic_results[*].title",
      "organic_results[*].link",
      "organic_results[*].snippet",
      "organic_results[*].displayed_link",
    ],
  },
  {
    tool: "google_search",
    rawFixture: "google-factual-question.json",
    outFile: "google-factual-question-restricted.json",
    params: { engine: "google", q: "what is the capital of France", num: 5 },
    formatterPaths: [
      "answer_box.answer",
      "organic_results[*].title",
      "organic_results[*].link",
      "organic_results[*].snippet",
    ],
  },
  {
    tool: "google_finance_search",
    rawFixture: "google-finance.json",
    outFile: "google-finance-restricted.json",
    params: { engine: "google_finance", q: "AAPL:NASDAQ" },
    formatterPaths: [
      "summary.title",
      "summary.price",
      "summary.currency",
      "summary.date",
      "summary.exchange",
      "summary.price_movement.value",
      "summary.price_movement.percentage",
      "knowledge_graph.key_stats.stats[*].label",
      "knowledge_graph.key_stats.stats[*].value",
      "news_results[*].snippet",
      "news_results[*].source",
    ],
  },
  {
    tool: "google_news_search",
    rawFixture: "google-news.json",
    outFile: "google-news-restricted.json",
    params: { engine: "google_news", q: "OpenAI" },
    formatterPaths: [
      "news_results[*].stories[*].title",
      "news_results[*].stories[*].source.name",
      "news_results[*].stories[*].link",
      "news_results[*].stories[*].date",
    ],
  },
  {
    tool: "google_maps_search",
    rawFixture: "google-maps.json",
    outFile: "google-maps-restricted.json",
    params: {
      engine: "google_maps",
      q: "coffee shops in San Francisco",
      type: "search",
    },
    formatterPaths: [
      "local_results[*].title",
      "local_results[*].rating",
      "local_results[*].address",
      "local_results[*].type",
    ],
  },
  {
    tool: "google_flights_search",
    rawFixture: "google-flights.json",
    outFile: "google-flights-restricted.json",
    params: {
      engine: "google_flights",
      departure_id: "JFK",
      arrival_id: "LAX",
      outbound_date: dateInFuture(30),
      type: "2",
      currency: "USD",
    },
    formatterPaths: [
      "best_flights[*].price",
      "best_flights[*].total_duration",
      "best_flights[*].flights[*].airline",
      "best_flights[*].flights[*].flight_number",
      "best_flights[*].flights[*].departure_airport.id",
      "best_flights[*].flights[*].arrival_airport.id",
    ],
  },
]

function dateInFuture(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// Walk a JSON value following a dotted path with [*] wildcards. Returns
// true if at least one leaf exists with a non-null, non-empty value.
function pathExists(json: unknown, path: string): boolean {
  const segments = path.split(".")
  const walk = (node: unknown, idx: number): boolean => {
    if (idx === segments.length) {
      if (node === null || node === undefined) return false
      if (typeof node === "string" && node.length === 0) return false
      return true
    }
    const seg = segments[idx]
    const arrayMatch = seg.match(/^(\w+)\[\*\]$/)
    if (arrayMatch) {
      const key = arrayMatch[1]
      const arr = (node as any)?.[key]
      if (!Array.isArray(arr)) return false
      return arr.some((item) => walk(item, idx + 1))
    }
    if (node === null || node === undefined || typeof node !== "object")
      return false
    return walk((node as any)[seg], idx + 1)
  }
  return walk(json, 0)
}

async function main(): Promise<void> {
  const key = process.env.SERPAPI_API_KEY
  if (!key) {
    console.error("SERPAPI_API_KEY is not set.")
    process.exit(1)
  }
  serpApiConfig.api_key = key
  serpApiConfig.timeout = 30_000
  await mkdir(OUT_DIR, { recursive: true })

  for (const probe of PROBES) {
    const restrictor = RESTRICTORS[probe.tool]
    if (!restrictor) {
      console.log(`✗ ${probe.tool}: no restrictor string`)
      continue
    }

    console.log(`\n=== ${probe.tool} (${probe.outFile}) ===`)
    console.log(`restrictor: ${restrictor}`)

    let restricted: any
    try {
      restricted = await getJson({
        ...probe.params,
        json_restrictor: restrictor,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`✗ SerpApi call failed: ${msg}`)
      continue
    }

    const outPath = resolve(OUT_DIR, probe.outFile)
    const restrictedJson = JSON.stringify(restricted, null, 2)
    await writeFile(outPath, restrictedJson, "utf8")

    let rawBytes = 0
    try {
      const rawJson = await readFile(resolve(OUT_DIR, probe.rawFixture), "utf8")
      rawBytes = Buffer.byteLength(rawJson, "utf8")
    } catch {
      rawBytes = -1
    }
    const restrictedBytes = Buffer.byteLength(restrictedJson, "utf8")
    const reduction =
      rawBytes > 0
        ? (((rawBytes - restrictedBytes) / rawBytes) * 100).toFixed(1) + "%"
        : "(no raw baseline)"

    console.log(
      `raw: ${(rawBytes / 1024).toFixed(1)} KB → restricted: ${(restrictedBytes / 1024).toFixed(1)} KB (${reduction} reduction)`
    )

    const topKeys = Object.keys(restricted ?? {}).filter(
      (k) => k !== "search_metadata" && k !== "search_parameters"
    )
    console.log(`top-level keys (excluding metadata): ${topKeys.join(", ")}`)

    console.log("formatter-expected paths:")
    for (const path of probe.formatterPaths) {
      const ok = pathExists(restricted, path)
      console.log(`  ${ok ? "✓" : "✗"} ${path}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
