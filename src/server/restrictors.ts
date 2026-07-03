// ─── Per-engine JSON Restrictor configuration ──────────
// SerpApi's `json_restrictor` query parameter does server-side field
// selection: you append it to a SerpApi call and the response arrives
// pre-trimmed, so a small local model only ever sees the fields it needs
// to answer. There is no client-side reshaping — the restricted response
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
// What `json_restrictor` does NOT do — if you need any of these you have
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

/**
 * Per-tool `json_restrictor` strings, one per engine. Each is a
 * comma-separated list of paths SerpApi keeps in the response.
 */
export const RESTRICTORS: Record<RestrictorTool, string> = {
  // Three branches, only the present ones come through per query:
  // `answer_box` (factual queries), `knowledge_graph` (entity queries),
  // and the top-5 organic results as the universal fallback.
  google_search: [
    "answer_box.{answer,snippet,title}",
    "knowledge_graph.{title,type,description,source.{name,link}}",
    "organic_results[0:5].{title,link,displayed_link,snippet,date}",
  ].join(","),

  // `summary.market` and `summary.extensions` are intentionally
  // excluded: the first now carries after-hours pricing (extra noise
  // for the model), the second is verbose locale strings the chat
  // already shows the user.
  google_finance_search: [
    "summary.{title,price,currency,date,exchange,stock,price_movement.{value,percentage,movement}}",
    "knowledge_graph.key_stats.stats[].{label,value}",
    "news_results[0:3].{snippet,title,source,link,date}",
  ].join(","),

  // Google News groups stories into clusters with a top-level `title`
  // plus a nested `stories[]` array. Keeping both lets the consumer
  // handle either shape without conditional logic — flat news in
  // `news_results[].title` or clustered news in
  // `news_results[].stories[0].title`.
  google_news_search: [
    "news_results[0:5].{title,link,source,date,snippet,stories[0:1].{title,link,source.name,date,snippet}}",
  ].join(","),

  // `local_results` is the regular search; `place_results` covers the
  // single-place fallback ("the Apple Store at 1 Infinite Loop").
  google_maps_search: [
    "local_results[0:5].{title,rating,reviews,type,address,price,open_state,phone,website,gps_coordinates}",
    "place_results.{title,rating,reviews,type,address,price,open_state,phone,website}",
  ].join(","),

  // SerpApi returns flights in two pools: `best_flights` (top
  // suggestions) and `other_flights` (the long tail). Top 3 of each is
  // enough for the model to pick from without flooding the context.
  google_flights_search: [
    "best_flights[0:3].{price,total_duration,type,flights[].{airline,flight_number,travel_class,departure_airport.{id,name,time},arrival_airport.{id,name,time},duration},layovers[].{id,name,duration}}",
    "other_flights[0:3].{price,total_duration,type,flights[].{airline,flight_number,travel_class,departure_airport.{id,name,time},arrival_airport.{id,name,time},duration},layovers[].{id,name,duration}}",
  ].join(","),

  // `amenities` and `nearby_places` are intentionally excluded: both are
  // long lists that bloat the context without changing which hotel the
  // model recommends — price, rating, and class carry the decision.
  google_hotels_search: [
    "properties[0:5].{name,type,link,hotel_class,overall_rating,reviews,rate_per_night.lowest,total_rate.lowest,check_in_time,check_out_time}",
  ].join(","),

  // `shopping_results` is the regular grid; `inline_shopping_results`
  // covers queries where Google answers with an inline carousel instead.
  // Both `link` and `product_link` are listed because results carry one
  // or the other depending on the seller.
  google_shopping_search: [
    "shopping_results[0:5].{title,link,product_link,source,price,extracted_price,old_price,rating,reviews,delivery}",
    "inline_shopping_results[0:3].{title,link,source,price,extracted_price,rating,reviews}",
  ].join(","),
}

/**
 * The same fields as `RESTRICTORS`, expanded to one flat path per leaf.
 * The UI matches these against the response tree to highlight which keys
 * came through — `[*]` stands for any array index. `search_metadata.*_url`
 * is included because SerpApi always returns `search_metadata` regardless
 * of the restrictor, and the UI links to it as the result's source.
 *
 * Keep this in sync with `RESTRICTORS` above: every leaf one string keeps
 * should have a matching entry here.
 */
export const KEPT_PATHS: Record<RestrictorTool, Array<string>> = {
  google_search: [
    "answer_box.answer",
    "answer_box.snippet",
    "answer_box.title",
    "knowledge_graph.title",
    "knowledge_graph.type",
    "knowledge_graph.description",
    "knowledge_graph.source.name",
    "knowledge_graph.source.link",
    "organic_results[*].title",
    "organic_results[*].link",
    "organic_results[*].displayed_link",
    "organic_results[*].snippet",
    "organic_results[*].date",
    "search_metadata.google_url",
  ],
  google_finance_search: [
    "summary.title",
    "summary.price",
    "summary.currency",
    "summary.date",
    "summary.exchange",
    "summary.stock",
    "summary.price_movement.value",
    "summary.price_movement.percentage",
    "summary.price_movement.movement",
    "knowledge_graph.key_stats.stats[*].label",
    "knowledge_graph.key_stats.stats[*].value",
    "news_results[*].snippet",
    "news_results[*].title",
    "news_results[*].source",
    "news_results[*].link",
    "news_results[*].date",
    "search_metadata.google_finance_url",
  ],
  google_news_search: [
    "news_results[*].title",
    "news_results[*].link",
    "news_results[*].source",
    "news_results[*].date",
    "news_results[*].snippet",
    "news_results[*].stories[*].title",
    "news_results[*].stories[*].link",
    "news_results[*].stories[*].source.name",
    "news_results[*].stories[*].date",
    "news_results[*].stories[*].snippet",
    "search_metadata.google_news_url",
  ],
  google_maps_search: [
    "local_results[*].title",
    "local_results[*].rating",
    "local_results[*].reviews",
    "local_results[*].type",
    "local_results[*].address",
    "local_results[*].price",
    "local_results[*].open_state",
    "local_results[*].phone",
    "local_results[*].website",
    "local_results[*].gps_coordinates",
    "place_results.title",
    "place_results.rating",
    "place_results.reviews",
    "place_results.type",
    "place_results.address",
    "place_results.price",
    "place_results.open_state",
    "place_results.phone",
    "place_results.website",
    "search_metadata.google_maps_url",
  ],
  google_flights_search: [
    "best_flights[*].price",
    "best_flights[*].total_duration",
    "best_flights[*].type",
    "best_flights[*].flights[*].airline",
    "best_flights[*].flights[*].flight_number",
    "best_flights[*].flights[*].travel_class",
    "best_flights[*].flights[*].duration",
    "best_flights[*].flights[*].departure_airport.id",
    "best_flights[*].flights[*].departure_airport.name",
    "best_flights[*].flights[*].departure_airport.time",
    "best_flights[*].flights[*].arrival_airport.id",
    "best_flights[*].flights[*].arrival_airport.name",
    "best_flights[*].flights[*].arrival_airport.time",
    "best_flights[*].layovers[*].id",
    "best_flights[*].layovers[*].name",
    "best_flights[*].layovers[*].duration",
    "other_flights[*].price",
    "other_flights[*].total_duration",
    "other_flights[*].type",
    "other_flights[*].flights[*].airline",
    "other_flights[*].flights[*].flight_number",
    "other_flights[*].flights[*].travel_class",
    "other_flights[*].flights[*].duration",
    "other_flights[*].flights[*].departure_airport.id",
    "other_flights[*].flights[*].departure_airport.name",
    "other_flights[*].flights[*].departure_airport.time",
    "other_flights[*].flights[*].arrival_airport.id",
    "other_flights[*].flights[*].arrival_airport.name",
    "other_flights[*].flights[*].arrival_airport.time",
    "other_flights[*].layovers[*].id",
    "other_flights[*].layovers[*].name",
    "other_flights[*].layovers[*].duration",
    "search_metadata.google_flights_url",
  ],
  google_hotels_search: [
    "properties[*].name",
    "properties[*].type",
    "properties[*].link",
    "properties[*].hotel_class",
    "properties[*].overall_rating",
    "properties[*].reviews",
    "properties[*].rate_per_night.lowest",
    "properties[*].total_rate.lowest",
    "properties[*].check_in_time",
    "properties[*].check_out_time",
    "search_metadata.google_hotels_url",
  ],
  google_shopping_search: [
    "shopping_results[*].title",
    "shopping_results[*].link",
    "shopping_results[*].product_link",
    "shopping_results[*].source",
    "shopping_results[*].price",
    "shopping_results[*].extracted_price",
    "shopping_results[*].old_price",
    "shopping_results[*].rating",
    "shopping_results[*].reviews",
    "shopping_results[*].delivery",
    "inline_shopping_results[*].title",
    "inline_shopping_results[*].link",
    "inline_shopping_results[*].source",
    "inline_shopping_results[*].price",
    "inline_shopping_results[*].extracted_price",
    "inline_shopping_results[*].rating",
    "inline_shopping_results[*].reviews",
    "search_metadata.google_shopping_url",
  ],
}
