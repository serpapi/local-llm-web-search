// ─── Per-engine JSON Restrictor configuration ──────────
// SerpApi's `json_restrictor` query parameter does server-side field
// selection: you append it to a SerpApi call and the response arrives
// pre-trimmed, so a small local model only ever sees the fields it needs
// to answer. There is no client-side reshaping. The restricted response
// is exactly what the model receives.
//
// Syntax (https://serpapi.com/json-restrictor):
//   - field selection      : organic_results
//   - array index          : organic_results[0]
//   - array slice          : organic_results[0:5]            (half-open, items 0–4)
//   - all items            : organic_results[]
//   - nested path          : knowledge_graph.source.link
//   - multi-field project. : organic_results[].{title,link,snippet}
//   - multiple top-level   : answer_box,knowledge_graph,organic_results
//
// What `json_restrictor` does NOT do. If you need any of these you have
// to post-process the response in your own code:
//   - field renaming                 (keys stay as SerpApi names them)
//   - value-level filtering          (no "only stats whose label matches X")
//   - label normalization            (no "Mkt. cap" → "market_cap")
//   - exclusion                      (whitelist only, never blacklist)
//   - computed or conditional output (no derived fields, no branching)
//
// Listing a path that the engine doesn't return for a given query is
// safe: SerpApi silently omits absent paths. That's why each string can
// list every branch the engine *might* return (e.g. both `answer_box`
// and `knowledge_graph`) and let the response decide which appear.

/**
 * Tool names that have a matching restrictor string. Keeping these as a
 * `const` tuple lets TypeScript flag a typo in the `RESTRICTORS` map at
 * compile time and gives callers a stable iteration order.
 */
export const RESTRICTOR_TOOLS = [
  "google_search",
  "google_finance_search",
  "google_news_search",
  "google_maps_search",
  "google_flights_search",
  "google_hotels_search",
  "google_shopping_search",
] as const

export type RestrictorTool = (typeof RESTRICTOR_TOOLS)[number]

/**
 * Narrow an arbitrary string (e.g. a tool name the model emitted) to a
 * known `RestrictorTool`. Lets callers index the tool maps without a
 * cast and reject unknown tools in the same step.
 */
export function isRestrictorTool(name: string): name is RestrictorTool {
  return (RESTRICTOR_TOOLS as ReadonlyArray<string>).includes(name)
}

// The AI Overview fields the model reads, per output mode. A search keeps
// them under `ai_overview` together with `page_token`, and the follow-up
// request in `AI_OVERVIEW_RESTRICTORS` asks for the same ones, so an
// overview reads the same whether Google sent it inline or deferred it.
// `references` are the pages the overview cites, so the model can link
// them instead of an organic result that doesn't say the same thing.
const AI_OVERVIEW_FIELDS = {
  json: "text_blocks[0:6].{snippet,list[0:5].{title,snippet}},references[0:3].{title,link,source}",
  markdown:
    "text_blocks[0:8].{snippet,list[0:6].{title,snippet}},references[0:4].{title,link,source}",
}

/**
 * Restrictors for the follow-up `google_ai_overview` request. Google
 * defers the AI Overview on many searches: the response then carries only
 * `ai_overview.page_token`, which expires within a minute, and the
 * overview itself costs one more request (see `followDeferredOverview` in
 * `agent.server.ts`). On 2026-10-21 Google deferred it for all seven
 * searches about SerpApi's CEO, and only the overview named him.
 */
export const AI_OVERVIEW_RESTRICTORS = {
  json: `ai_overview.{${AI_OVERVIEW_FIELDS.json}}`,
  markdown: `ai_overview.{${AI_OVERVIEW_FIELDS.markdown}}`,
}

/**
 * Per-tool `json_restrictor` strings for JSON mode, one per engine. Each is
 * a comma-separated list of paths SerpApi keeps in the response. These are
 * the tight restrictors from the original article; Markdown mode uses
 * `MARKDOWN_RESTRICTORS` below.
 *
 * Every restrictor also keeps `search_metadata.<engine>_url`, the link to
 * the live SERP behind the result. The agent captures that URL for the
 * Sources panel and then removes `search_metadata` before the model sees
 * the response, so the model's context stays limited to answer fields.
 *
 * And every restrictor keeps `error`, which SerpApi sets when a search
 * found nothing ("Google Flights hasn't returned any results"). Without
 * it the model gets an empty result and guesses why. It costs nothing
 * when the search has results.
 */
export const RESTRICTORS: Record<RestrictorTool, string> = {
  // Only the branches present for a query come through: `answer_box`
  // (factual queries), `ai_overview` (where Google now puts most direct
  // answers), `knowledge_graph` (entity queries), and the top-5 organic
  // results as the universal fallback. Without the AI Overview, "Who is
  // the current CEO of Perplexity?" reached the model as five unrelated
  // organic results and it kept searching instead of answering. When
  // Google defers the overview, `page_token` comes through and the agent
  // fetches the overview with it. `related_questions` is left out: in 10
  // searches on 2026-10-21, none of the 40 questions came with an answer,
  // so a question about SerpApi's CEO reached the model with "Who is the
  // 2nd CEO of Google?" and nothing else.
  google_search: [
    "answer_box.{answer,snippet,title}",
    `ai_overview.{page_token,${AI_OVERVIEW_FIELDS.json}}`,
    "knowledge_graph.{title,type,description,source.{name,link}}",
    "organic_results[0:5].{title,link,displayed_link,snippet,date}",
    "error",
    "search_metadata.google_url",
  ].join(","),

  // `summary.market` and `summary.extensions` are intentionally
  // excluded: the first now carries after-hours pricing (extra noise
  // for the model), the second is verbose locale strings the chat
  // already shows the user.
  google_finance_search: [
    "summary.{title,price,currency,date,exchange,stock,price_movement.{value,percentage,movement}}",
    "knowledge_graph.key_stats.stats[].{label,value}",
    "news_results[0:3].{snippet,title,source,link,date}",
    "error",
    "search_metadata.google_finance_url",
  ].join(","),

  // Google News groups stories into clusters with a top-level `title`
  // plus a nested `stories[]` array. Keeping both lets the consumer
  // handle either shape without conditional logic: flat news in
  // `news_results[].title` or clustered news in
  // `news_results[].stories[0].title`.
  google_news_search: [
    "news_results[0:5].{title,link,source,date,snippet,stories[0:1].{title,link,source.name,date,snippet}}",
    "error",
    "search_metadata.google_news_url",
  ].join(","),

  // `local_results` is the regular search; `place_results` covers the
  // single-place fallback ("the Apple Store at 1 Infinite Loop").
  google_maps_search: [
    "local_results[0:5].{title,rating,reviews,type,address,price,open_state,phone,website,gps_coordinates}",
    "place_results.{title,rating,reviews,type,address,price,open_state,phone,website}",
    "error",
    "search_metadata.google_maps_url",
  ].join(","),

  // SerpApi returns flights in two pools: `best_flights` (top
  // suggestions) and `other_flights` (the long tail). Top 3 of each is
  // enough for the model to pick from without flooding the context.
  google_flights_search: [
    "best_flights[0:3].{price,total_duration,type,flights[].{airline,flight_number,travel_class,departure_airport.{id,name,time},arrival_airport.{id,name,time},duration},layovers[].{id,name,duration}}",
    "other_flights[0:3].{price,total_duration,type,flights[].{airline,flight_number,travel_class,departure_airport.{id,name,time},arrival_airport.{id,name,time},duration},layovers[].{id,name,duration}}",
    "error",
    "search_metadata.google_flights_url",
  ].join(","),

  // `amenities` and `nearby_places` are intentionally excluded: both are
  // long lists that bloat the context without changing which hotel the
  // model recommends. Price, rating, and class carry the decision.
  google_hotels_search: [
    "properties[0:5].{name,type,link,hotel_class,overall_rating,reviews,rate_per_night.lowest,total_rate.lowest,check_in_time,check_out_time}",
    "error",
    "search_metadata.google_hotels_url",
  ].join(","),

  // `shopping_results` is the regular grid; `inline_shopping_results`
  // covers queries where Google answers with an inline carousel instead.
  // Both `link` and `product_link` are listed because results carry one
  // or the other depending on the seller.
  google_shopping_search: [
    "shopping_results[0:5].{title,link,product_link,source,price,extracted_price,old_price,rating,reviews,delivery}",
    "inline_shopping_results[0:3].{title,link,source,price,extracted_price,rating,reviews}",
    "error",
    "search_metadata.google_shopping_url",
  ].join(","),
}

/**
 * Looser restrictors for Markdown mode. Markdown drops JSON's keys, quotes
 * and braces, so the same token budget carries more fields and more items.
 * Each string here is sized to land near the JSON (Restrictor) count for
 * the same call, from payloads measured on `/bench`: tighter than
 * the Sep 14 and Sep 22 Markdown restrictors (8 to 10 items, full
 * `knowledge_graph`, `financials`, `amenities`), which ran 1.5 to 3 times
 * the JSON size and made models mirror the extra rows into long answers.
 *
 * Fields added over `RESTRICTORS` are the ones that change an answer:
 * hours and a description for places, related stories for news, aircraft,
 * legroom and overnight layovers for flights, a description and location
 * rating for hotels, the old price and condition for products.
 */
export const MARKDOWN_RESTRICTORS: Record<RestrictorTool, string> = {
  // Organic results lead, five of them, as in JSON mode. When Google has no
  // AI Overview, answer box or knowledge graph for a question, the answer
  // has to come from the organic results. With 3 organic results, listed
  // after the related questions, Qwen 3.8, Gemma 4 and Bonsai each ran out
  // of search rounds on at least one question about SerpApi's CEO,
  // founding year or prices. SerpApi writes the sections in the order the
  // paths are listed. With five results, Search measured 466 tokens on
  // /bench, against 620 in JSON. The fields and the dropped
  // `related_questions` follow `RESTRICTORS.google_search`.
  google_search: [
    "organic_results[0:5].{title,link,snippet,date}",
    "answer_box.{answer,snippet,title,list}",
    `ai_overview.{page_token,${AI_OVERVIEW_FIELDS.markdown}}`,
    "knowledge_graph.{title,type,description,source.{name,link}}",
    "top_stories[0:3].{title,link,source,date}",
    "error",
    "search_metadata.google_url",
  ].join(","),

  google_finance_search: [
    "summary.{title,price,currency,date,exchange,stock,price_movement.{value,percentage,movement}}",
    "knowledge_graph.key_stats.stats[].{label,value}",
    "knowledge_graph.about[0:1].{description.snippet}",
    "news_results[0:5].{snippet,title,source,link,date}",
    "error",
    "search_metadata.google_finance_url",
  ].join(","),

  google_news_search: [
    "news_results[0:7].{title,link,source.name,date,snippet,stories[0:2].{title,link,source.name,date}}",
    "error",
    "search_metadata.google_news_url",
  ].join(","),

  google_maps_search: [
    "local_results[0:6].{title,rating,reviews,type,address,price,open_state,hours,phone,website,description}",
    "place_results.{title,rating,reviews,type,address,price,open_state,hours,phone,website,description}",
    "error",
    "search_metadata.google_maps_url",
  ].join(","),

  google_flights_search: [
    "best_flights[0:4].{price,total_duration,type,flights[].{airline,flight_number,airplane,travel_class,departure_airport.{id,time},arrival_airport.{id,time},duration,legroom},layovers[].{id,duration,overnight}}",
    "other_flights[0:4].{price,total_duration,type,flights[].{airline,flight_number,departure_airport.{id,time},arrival_airport.{id,time},duration},layovers[].{id,duration}}",
    "price_insights.{lowest_price,price_level,typical_price_range}",
    "error",
    "search_metadata.google_flights_url",
  ].join(","),

  google_hotels_search: [
    "properties[0:7].{name,type,link,description,hotel_class,overall_rating,reviews,location_rating,rate_per_night.lowest,total_rate.lowest,check_in_time,check_out_time}",
    "error",
    "search_metadata.google_hotels_url",
  ].join(","),

  google_shopping_search: [
    "shopping_results[0:7].{title,product_link,source,price,old_price,rating,reviews,delivery,second_hand_condition}",
    "inline_shopping_results[0:3].{title,link,source,price,rating,reviews}",
    "error",
    "search_metadata.google_shopping_url",
  ].join(","),
}
