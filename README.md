# Connect Your Local LLM with Web Search Data

Give a local LLM access to real-time web data. The model decides what to search for, your code runs that search through SerpApi, and the model answers with fresh results in hand. Inference stays on your hardware. The only thing that leaves your machine is the search query the model chose to issue.

This is the companion repository for the SerpApi article [How to Connect Your Local LLM with Web Search Data](https://serpapi.com/blog/how-to-connect-your-local-llm-with-web-search-data/). The link goes live on publication.

## What it does

- Runs a chat UI built on **TanStack Start** and **shadcn/ui**.
- Talks to a local model served by **LM Studio** through its OpenAI-compatible API at `http://localhost:1234/v1`.
- Gives the model **seven named SerpApi tools**: `google_search`, `google_finance_search`, `google_news_search`, `google_maps_search`, `google_flights_search`, `google_hotels_search`, and `google_shopping_search`.
- Trims each SerpApi response server-side with the **`json_restrictor`** parameter, so the model only ever receives the fields it needs to answer. The sidebar compares raw against restricted, where the cut is around 99 percent.
- Shows a live **token breakdown** of the context window and a **latency breakdown** for each phase: choosing the tool, calling SerpApi, and writing the answer.
- Validates tool arguments with **Zod** and returns typed errors with a suggestion the user can act on.
- Keeps the SerpApi key server-side through a TanStack Start server function. The key never ships in a client bundle.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer.
- [LM Studio](https://lmstudio.ai) running on `localhost:1234` with a function-calling model loaded. Qwen 3.5 9B is the recommended choice, since smaller models struggle with tool arguments.
- A [SerpApi](https://serpapi.com) account and API key.

## Quickstart

```bash
bun install
cp .env.example .env
# edit .env and add your SERPAPI_API_KEY
bun dev
```

Open http://localhost:3000 and ask something like "What's the current price of AAPL stock?".

## Hardware

The recommended Qwen 3.5 9B Q4_K_M needs roughly **8 GB of free RAM or VRAM** to load, plus about 10 GB of headroom while it answers. A 16 GB MacBook with unified memory, or any GPU with 12 GB or more, runs it without trouble. On an 8 GB machine, drop to a 4B model. The answers get weaker, but the demo still works.

## Context window sizing

LM Studio loads every model at a **default context of 4096 tokens** unless you tell it otherwise. That window is too small for a multi-turn chat that carries tool results, so this app sets the context explicitly when it loads a model.

The right size depends on the machine, and there is no single safe number. A 36 GB Mac fits far more than a 16 GB laptop. A Windows or Linux box with a discrete GPU is bound by **VRAM**, not system RAM.

So the app does not try to predict memory use. It lets **LM Studio's own memory guardrail** decide, then probes for the largest size that fits.

The probe lives in `ensureModelLoaded` (`src/server/agent.ts`) and works in four steps:

1. Start optimistic at `min(model.max_context_length, 32768)`. That 32K default is eight times LM Studio's 4K.
2. Call `POST /api/v1/models/load` at that size. LM Studio estimates the memory and either loads it (HTTP 200) or blocks it (a non-2xx response with a `"requires approximately N GB"` message).
3. On a block, halve the size (32768 → 16384 → 8192 → 4096) and retry. Blocked attempts return instantly because no model actually loads, so the probe stays cheap.
4. Keep the largest size LM Studio accepts. The app then trims history to fit that window, and the sidebar reports it as the real loaded budget rather than the optimistic start.

The accept-or-reject decision comes from LM Studio's per-platform estimator, so the same code is correct on Apple Silicon unified memory and on discrete-GPU VRAM. Here is a measured back-off for `gemma-4-31b` on a 36 GB M4 Max:

```
262144 → blocked (~87 GB)
131072 → blocked (~53 GB)
 65536 → blocked (~36.5 GB)
 32768 → loaded ✅   ← largest that fits
```

The app runs **one model at a time**. Selecting a model unloads any other loaded model first, so the guardrail gets the full memory budget instead of competing with a model you tried earlier.

### Configuration

| Env var                   | Default                 | Effect                                                                                                                                                                                                             |
| ------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LMSTUDIO_URL`            | `http://localhost:1234` | Base URL of the LM Studio server. Both the OpenAI-compatible (`/v1`) and native (`/api/v1`) endpoints derive from it, so one variable covers a non-default port or a server on another machine.                    |
| `LMSTUDIO_CONTEXT_LENGTH` | unset                   | Pin an exact context size (tokens, 4096 or higher) and skip the probe. Set it when you know what your machine fits. If the pinned size does not fit, the load fails and the app keeps whatever was already loaded. |
| `LMSTUDIO_TTL_SECONDS`    | `300`                   | Seconds an idle model stays loaded before the app unloads it. See [Idle auto-unload](#endpoints) below.                                                                                                            |

Two LM Studio settings matter at the edges:

- **Model Load Guardrails** (Settings → Hardware) ship strict. This is what blocks oversized loads, so keep it on. If it over-estimates on your machine, which happens occasionally on unified memory, loosen it here. There is no REST "load anyway" override, so the app respects whatever this setting decides.
- **Offload KV Cache to GPU Memory**: on a low-VRAM GPU, turning this off moves the KV cache to system RAM. Generation runs slower, but you can load larger contexts than VRAM alone allows.

### Endpoints

The app uses LM Studio's **native** API (`http://localhost:1234/api/v1`) for listing, loading, and unloading models, and the **OpenAI-compatible** API (`http://localhost:1234/v1`) for chat completions. On the load endpoint, the app sends `model`, `context_length`, and `flash_attention`. A `ttl` key is not accepted there and returns HTTP 400, so the app never sends one.

**Idle auto-unload.** The app loads models explicitly so it can size the context window to your machine, which pins them. Per [LM Studio's docs](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict), models loaded this way "do not have a TTL, and will remain loaded in memory until you manually unload them", because LM Studio's idle-TTL only evicts JIT-loaded models. So the app handles the idle unload itself. After each query it arms a timer that unloads the model once it has been idle for five minutes. Override the window with `LMSTUDIO_TTL_SECONDS`.

## Troubleshooting

| Symptom                                                   | What to try                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Failed to fetch http://localhost:1234/v1/models`         | LM Studio isn't running or the OpenAI-compatible server is off. Start it from LM Studio → **Developer** → **Start Server**, then verify with `curl http://localhost:1234/v1/models`.                                                                                                  |
| `SerpApi rejected the API key` (401)                      | Re-check `SERPAPI_API_KEY` in `.env`. Restart `bun dev` after editing, since the app reads env at module load.                                                                                                                                                                        |
| `EADDRINUSE: address already in use :::3000`              | Another process holds port 3000. Either kill it (`lsof -i :3000` then `kill <pid>`) or run on a different port: `vite dev --port 3001`.                                                                                                                                               |
| Model picks the wrong tool or hallucinates args           | Switch to a larger function-calling model such as Qwen 3.5 9B or Llama 3.1 8B Instruct. Models below 7B are unreliable with `tool_choice: "auto"`.                                                                                                                                    |
| Conversation forgets context fast, or "loaded" reads 4096 | The model is stuck at LM Studio's default window. Read the [Context window sizing](#context-window-sizing) section. The sidebar's "loaded" value shows what was actually loaded. If it is low, your machine is backing off (load a smaller model) or your guardrails are over-strict. |

## Available tools

| Tool                     | Example query                                  |
| ------------------------ | ---------------------------------------------- |
| `google_search`          | Who won the last F1 race?                      |
| `google_finance_search`  | What's the current price of AAPL?              |
| `google_news_search`     | Latest news about AI regulation                |
| `google_maps_search`     | Barbecue restaurants in Austin, Texas          |
| `google_flights_search`  | Flights from SCL to MAD on 2026-05-15          |
| `google_hotels_search`   | Hotels in Barcelona, May 15–18, for two adults |
| `google_shopping_search` | Best price for AirPods Pro 2                   |

Each tool sends a `json_restrictor` string with its SerpApi call. SerpApi trims the response on its own servers down to the handful of fields the model needs to answer. The token breakdown sidebar shows how much context each tool saves on every query.

## Scripts

```bash
bun run dev         # start the dev server on :3000
bun run build       # production build
bun run typecheck   # tsc --noEmit
bun run lint        # eslint
bun run test        # vitest run (unit tests)
bun run format      # prettier --write
```

There is no CI in this repo. Run `bun run typecheck`, `bun run lint`, and `bun run test` yourself before you commit.

## Files

| Path                                 | Purpose                                                                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/server/agent.ts`                | Tools, Zod schemas, executors, token counting, the idle-unload timer, and the `runQuery` server function. Every SerpApi call happens here, so the key never leaves the server. |
| `src/server/restrictors.ts`          | The `json_restrictor` string and kept-field list for each of the seven engines.                                                                                                |
| `src/routes/index.tsx`               | Chat page, token breakdown sidebar, latency panel, and dark-mode toggle.                                                                                                       |
| `src/components/error-boundary.tsx`  | App-wide error boundary with a reload fallback.                                                                                                                                |
| `src/components/ui/*`                | shadcn/ui primitives.                                                                                                                                                          |
| `src/server/__tests__/agent.test.ts` | Unit tests for history trimming, secret redaction, inline tool-call parsing, country-code normalization, and context sizing.                                                   |
| `.env.example`                       | Environment variable template.                                                                                                                                                 |

## Security

The app reads `SERPAPI_API_KEY` only inside `src/server/agent.ts`, which runs inside TanStack Start's server function boundary. No client route imports it, the browser bundle never sees it, and the app never logs it. Before persisting a query, `measurements/benchmark_log.json` redacts likely secrets from it.

## Notes

### Why named per-engine tools instead of one generic `search(engine, query)`

Small models in the 4B to 9B range reliably pick a tool by **name**, but they often mis-set string parameters like `engine`. Splitting the work into specific tools (`google_search`, `google_news_search`, and the rest) removes a whole class of tool-argument errors. You write a few more tool definitions and avoid many failed calls.

### Why `json_restrictor` matters

A raw SerpApi response is large, from 3,000 to more than 50,000 tokens depending on the engine. A 9B model with a 32K context window cannot afford to swallow that. You pass a `json_restrictor` with the request, and SerpApi returns only the fields you asked for: the top five organic results, the summary block, a few news headlines. You see the savings in the sidebar on every query.

### Why raw JSON stays out of the "Context used" total

The model only ever receives the restricted response. The app fetches the full, unrestricted JSON only when you open the comparison view, and it counts those tokens separately. Adding them to the total would be misleading, because the point of the pattern is that the raw JSON is _observed_ but never _sent_.

### How multi-turn chat fits the window

Each turn sends the full conversation history back to the model, the same pattern OpenAI and Anthropic document for tool use. The client accumulates messages (user questions, assistant answers, tool calls, tool results) and ships them on every `runQuery`. When the history plus the current turn would pass about 80 percent of the loaded context, the server drops the oldest non-system messages until it fits. The chat header shows `N turns in memory`, and `N older turns dropped to fit` when trimming starts. **Clear chat** resets the history to zero.

### Which model to load

Qwen 3.5 9B (any Q4_K_M GGUF in LM Studio) is the sweet spot for this demo on a MacBook. It follows tool-calling conventions reliably and fits in 16 GB of unified memory. Llama 3.1 8B Instruct also works. Anything below 7B is hit-or-miss with `tool_choice: "auto"`.
