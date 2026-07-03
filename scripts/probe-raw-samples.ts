// Capture one representative raw SerpApi response per engine and dump
// it to `measurements/raw-samples/<engine>.json`. The dumps are the
// ground truth that backs the offline formatter smoke check and the
// JSON Restrictor benchmark — when SerpApi's response shape changes,
// re-run this script to refresh them.
//
// Run with `bun run scripts/probe-raw-samples.ts`. Costs one SerpApi
// credit per probe.

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { getJson, config as serpApiConfig } from "serpapi"

const OUT_DIR = resolve(
  import.meta.dirname,
  "..",
  "measurements",
  "raw-samples"
)

type Probe = {
  filename: string
  params: Record<string, unknown>
  note: string
}

// Probes mirror the executor parameter shapes used by the agent.
// If you change an executor's defaults in `src/server/agent.ts`, update
// the matching entry here so the dump stays representative of what the
// agent sees at runtime.
const PROBES: Array<Probe> = [
  {
    filename: "google-entity-bare.json",
    params: { engine: "google", q: "Linus Torvalds", num: 5 },
    note: "bare entity name — triggers knowledge_graph",
  },
  {
    filename: "google-factual-question.json",
    params: { engine: "google", q: "what is the capital of France", num: 5 },
    note: "explicit question — triggers answer_box",
  },
  {
    filename: "google-finance.json",
    params: { engine: "google_finance", q: "AAPL:NASDAQ" },
    note: "stock symbol — exercises summary, key_stats, news",
  },
  {
    filename: "google-news.json",
    params: { engine: "google_news", q: "OpenAI" },
    note: "topic — exercises clustered news_results",
  },
  {
    filename: "google-maps.json",
    params: {
      engine: "google_maps",
      q: "coffee shops in San Francisco",
      type: "search",
    },
    note: "local search — exercises local_results",
  },
  {
    filename: "google-flights.json",
    params: {
      engine: "google_flights",
      departure_id: "JFK",
      arrival_id: "LAX",
      // SerpApi rejects past dates. ~30 days out keeps the probe valid
      // long after the script was written.
      outbound_date: dateInFuture(30),
      type: "2",
      currency: "USD",
    },
    note: "one-way flight — exercises best_flights + other_flights",
  },
  {
    filename: "google-hotels.json",
    params: {
      engine: "google_hotels",
      q: "hotels in Barcelona",
      check_in_date: dateInFuture(30),
      check_out_date: dateInFuture(33),
      adults: 2,
      currency: "USD",
    },
    note: "city stay — exercises properties with rates and ratings",
  },
  {
    filename: "google-shopping.json",
    params: { engine: "google_shopping", q: "airpods pro 2" },
    note: "product query — exercises shopping_results grid",
  },
]

function dateInFuture(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

async function main(): Promise<void> {
  const key = process.env.SERPAPI_API_KEY
  if (!key) {
    console.error(
      "SERPAPI_API_KEY is not set. Add it to .env at the repo root, then re-run."
    )
    process.exit(1)
  }
  serpApiConfig.api_key = key
  serpApiConfig.timeout = 30_000

  await mkdir(OUT_DIR, { recursive: true })

  console.log(`Writing raw samples to ${OUT_DIR}`)
  for (const probe of PROBES) {
    const target = resolve(OUT_DIR, probe.filename)
    process.stdout.write(`  ${probe.filename.padEnd(32)} — ${probe.note} … `)
    try {
      const raw = await getJson(probe.params)
      await mkdir(dirname(target), { recursive: true })
      const json = JSON.stringify(raw, null, 2)
      await writeFile(target, json, "utf8")
      const sizeKb = (Buffer.byteLength(json, "utf8") / 1024).toFixed(1)
      console.log(`ok (${sizeKb} KB)`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`FAIL — ${msg}`)
    }
  }
  console.log("Done.")
}

main().catch((err) => {
  console.error("probe-raw-samples crashed:", err)
  process.exit(1)
})
