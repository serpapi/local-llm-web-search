# SerpApi Local Agent Lab

Give a local LLM access to real-time web data. The model decides what to search for, your code runs that search through SerpApi, and the model reads the results and either answers or searches again, up to three rounds. Inference stays on your hardware. The only thing that leaves your machine is the search query the model chose.

This is the companion repository for the SerpApi article [How to Connect Your Local LLM with Web Search Data](https://serpapi.com/blog/how-to-connect-your-local-llm-with-web-search-data/).

## What it does

- Runs a chat UI built on TanStack Start and shadcn/ui, with model output typeset by shadcn/typeset.
- Talks to a local model served by LM Studio through its OpenAI-compatible API at `http://localhost:1234/v1`.
- Gives the model seven SerpApi tools: `google_search`, `google_finance_search`, `google_news_search`, `google_maps_search`, `google_flights_search`, `google_hotels_search`, and `google_shopping_search`.
- Runs an agent loop: every call carries the tools, so the model can check an answer or fix a search that missed, for up to three rounds. After the third, the answer call goes without tools, as in the last round of LM Studio's own `.act()`, and tells the model it can't search again. If the model still writes a search instead of an answer, or LM Studio can't parse its reply twice in a row, the app asks once more with the search results as plain text.
- Trims each SerpApi response on SerpApi's servers with the `json_restrictor` parameter, so the model only receives the fields it needs. The sidebar shows the size the model received and, when you ask for it, the raw size next to it, and counts every SerpApi search the chat has spent.
- Lets you pick what the model reads as a tool result: SerpApi's JSON response, or its [Markdown output](https://serpapi.com/markdown-output) (`output=md`), with or without a restrictor.
- Shows live progress while a query runs (loading the model, thinking, calling SerpApi, writing the answer), then LM Studio's token count for the model's last call, split into its parts, and the time each phase took.
- Lists every search result page the model used as a clickable source under the answer.
- Validates tool arguments with Zod. A bad argument ends the turn with an error that says what was wrong and what to try.
- Keeps the SerpApi key on the server. It never ships in a client bundle.

## Requirements

- [Bun](https://bun.sh) 1.3 or newer.
- [LM Studio](https://lmstudio.ai) running on `localhost:1234` with a model trained for tool use. See [Which model to load](#which-model-to-load).
- A [SerpApi](https://serpapi.com) account and API key.

## Quickstart

```bash
bun install
cp .env.example .env
# edit .env and add your SERPAPI_API_KEY
bun dev
```

Open http://localhost:3005 and ask something like "What's the current price of AAPL stock?".

## Hardware

The app was tested on a MacBook Pro M4 Max with 36 GB of RAM and a MacBook Pro M5 Pro with 48 GB, with LM Studio 0.4.25. The benchmark numbers in the article come from the 48 GB MacBook, which ran the model while the app ran on the other Mac through LM Link.

Machines with less memory were not tested. The model and its context window both have to fit in RAM, or in VRAM on a discrete GPU. If they don't, LM Studio refuses the load with its memory estimate, and the app tries a smaller window (see [Context window sizing](#context-window-sizing)). On a smaller machine, start with Gemma 4 12B QAT, the smallest model tested.

### Which model to load

These four models were tested end to end on the 13 benchmark questions. LM Studio lists them as staff picks for a 48 GB Mac.

| Model                 | LM Studio ID             | Format | Answered out of 13 (JSON / Markdown / Raw) | 7 search questions in Markdown |
| --------------------- | ------------------------ | ------ | ------------------------------------------ | ------------------------------ |
| Qwen 3.8 27B          | `qwen/qwen3.8-27b`       | MLX    | 13 / 13 / 11                               | 356 s                          |
| Meta Muse Glimmer 28B | `meta/muse-glimmer`      | GGUF   | 13 / 12 / 12                               | 414 s                          |
| Prism Bonsai 27B      | `prism-ml/bonsai-27b`    | MLX    | 13 / 13 / 11                               | 252 s                          |
| Gemma 4 12B QAT       | `google/gemma-4-12b-qat` | GGUF   | 13 / 13 / 11                               | 118 s                          |

Every Raw miss is a Finance question whose page does not fit a 32K window.

The app picks Qwen 3.8 27B by default when it is installed. In the long-conversation tests it turned follow-ups like "around there" and "which of those" into the right searches. Gemma 4 12B QAT answers about three times faster and needs less memory, but it has most of the [known limitations](#known-limitations). Models below 7B are unreliable with `tool_choice: "auto"`.

## Context window sizing

LM Studio loads a model with its default context of 8,192 tokens unless you ask for another size. That default was 4,096 before LM Studio 0.4.16, and you can change it in LM Studio's settings. It is too small for a chat that carries tool results, so the app asks for a size when it loads a model.

The right size depends on the machine. A 36 GB Mac fits far more than a 16 GB laptop, and a Windows or Linux box with a discrete GPU is limited by VRAM, not system RAM. So the app does not guess. LM Studio's memory guardrail decides, and the app looks for the largest size it accepts.

`ensureModelLoaded` in `src/server/agent.ts` does this in four steps:

1. Start at 32,768 tokens, or the model's maximum if that is smaller. A bigger window does not make answers better, and on GGUF models LM Studio reserves memory for the whole window when it loads.
2. Load the model at that size with `POST /api/v1/models/load` and `echo_load_config: true`. LM Studio either loads it and returns the config it applied, or refuses with HTTP 500, "insufficient system resources", and its memory estimate. A refusal takes under a tenth of a second, because nothing loads.
3. After a refusal, try 3/4, 1/2, 3/8, 1/4 and 1/8 of the start, then 4,096. Any other failure, such as an unknown model, an engine error or a dropped LM Link connection, is shown right away with LM Studio's message, because a smaller size would not fix it.
4. Use the smaller of the size requested and the size LM Studio applied. The app trims history to that window, and the sidebar shows it.

LM Studio's estimate accounts for the platform, so the same code works on Apple Silicon and on discrete GPUs. This is a real run on a 48 GB MacBook Pro for `gemma-4-31b-qat`, starting at 131,072:

```
131072  refused (about 52.4 GB)
 98304  refused (about 43.9 GB)
 65536  loaded, the largest size that fits
```

**MLX models size their own window.** On GGUF models the requested size is exact, and LM Studio rejects a longer prompt with `exceed_context_size_error`. LM Studio's MLX engine instead fits the window to free memory and keeps the larger of that and the request. Asked for 32,768, Qwen 3.8 27B got 61,696 on a 36 GB Mac and 119,552 on a 48 GB one. So the app checks the model's own prompt count after each call, and stops a turn whose prompt is over the size it asked for. Every model then works within the same window.

The app runs one model at a time. Each question unloads any other LLM before it loads the selected one, so the guardrail can use all the memory. Embedding models stay loaded. A question for another model while one is still answering fails with a message saying so.

### Configuration

| Env var                   | Default                 | Effect                                                                                                                                                                              |
| ------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LMSTUDIO_URL`            | `http://localhost:1234` | Base URL of the LM Studio server. The app builds both the OpenAI-compatible (`/v1`) and native (`/api/v1`) URLs from it.                                                            |
| `LMSTUDIO_CONTEXT_LENGTH` | unset                   | Load at this size (4,096 or more, rounded down to a multiple of 1,024) and skip the search for a size that fits. If LM Studio refuses it, the turn fails with LM Studio's estimate. |
| `LMSTUDIO_TTL_SECONDS`    | `300`                   | Seconds an idle model stays loaded before the app unloads it. See [Endpoints](#endpoints).                                                                                          |
| `LMSTUDIO_API_KEY`        | unset                   | A token from LM Studio's Developer page. Needed only when **Require Authentication** is on in its server settings; the app sends it as `Authorization: Bearer` to both APIs.        |

Two LM Studio settings also matter:

- **Model loading guardrails** (Settings, Hardware) is what refuses oversized loads, so keep it on. The API has no way to override it.
- **Offload KV cache to GPU memory.** On a GPU with little VRAM, turning this off moves the KV cache to system RAM. Answers get slower, but larger contexts fit.

### Endpoints

The app uses LM Studio's native API (`http://localhost:1234/api/v1`) to list, load and unload models, and the OpenAI-compatible API (`http://localhost:1234/v1`) for chat completions. The load request sends `model`, `context_length`, `flash_attention` and `echo_load_config`. LM Studio rejects a `ttl` key on that endpoint with HTTP 400, so the app never sends one.

The app loads models itself to choose the context size, and [LM Studio's docs](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict) say models loaded this way "do not have a TTL, and will remain loaded in memory until you manually unload them". So the app unloads them itself: after each query it starts a timer that unloads the model after five idle minutes. Change that with `LMSTUDIO_TTL_SECONDS`.

## Troubleshooting

| Symptom                                                         | What to try                                                                                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Failed to fetch http://localhost:1234/v1/models`               | LM Studio isn't running, or its server is off. Start it from LM Studio, Developer, Start Server, then check with `curl http://localhost:1234/v1/models`.                                               |
| `SerpApi request failed: Invalid API key`                       | Check `SERPAPI_API_KEY` in `.env`, then restart `bun dev`. The app reads the env file at startup.                                                                                                      |
| `EADDRINUSE: address already in use :::3005`                    | Another process holds port 3005. Stop it (`lsof -i :3005`, then `kill <pid>`), or run on another port with `bun run dev -- --port 3006`.                                                               |
| The model picks the wrong tool or invents arguments             | Use one of the models in [Which model to load](#which-model-to-load). Models below 7B are unreliable with `tool_choice: "auto"`.                                                                       |
| The chat forgets things fast, or "loaded" reads 8,192 or less   | The model is at LM Studio's default window, or your machine had to step down. Read [Context window sizing](#context-window-sizing). Load a smaller model, or loosen the guardrails if they are strict. |
| `LM Link connection entered error state peer_keepalive_timeout` | The machine running the model through LM Link went to sleep or lost its network. Keep it awake while you use it, then try again.                                                                       |

## Known limitations

These came up in long test conversations, mostly with Gemma 4 12B QAT, and are not fixed.

- **Answer language.** Once the user mentions a city like Montevideo, Gemma searches in Spanish and answers English questions in Spanish. The system prompt asks for the user's language, and Gemma ignores it.
- **Invented prices.** Asked for the best price of a Ryzen 7 9800X3D, Gemma gave a "typical market price" that was not in the search results.
- **Ambiguous questions.** "Whats the score of the real madrid game" came back with the women's team's result, without saying so. Gemma used news search, not web search, where Google shows live scores.
- **Raw Markdown and large pages.** In Markdown (Raw), a Finance question or a weather search can pass a 32K window: a Madrid forecast came to 34,418 tokens. The app stops the turn and shows the prompt size, but only after the model has read the prompt, which took Qwen 3.8 27B 155 s.

## Available tools

| Tool                     | Example query                                     |
| ------------------------ | ------------------------------------------------- |
| `google_search`          | Who won the last F1 race?                         |
| `google_finance_search`  | What's the current price of AAPL?                 |
| `google_news_search`     | Latest news about AI regulation                   |
| `google_maps_search`     | Barbecue restaurants in Austin, Texas             |
| `google_flights_search`  | Flights from SCL to MAD on 2026-05-15             |
| `google_hotels_search`   | Hotels in Barcelona, May 15 to 18, for two adults |
| `google_shopping_search` | Best price for AirPods Pro                        |

### Tool output: JSON or Markdown

The output picker, after the Examples button and the model picker, sets what SerpApi returns to the model.

| Mode                                | Request                               | Restrictor             | Typical tool result |
| ----------------------------------- | ------------------------------------- | ---------------------- | ------------------- |
| **JSON (Restrictor)**               | `output=json` via the SDK's `getJson` | `RESTRICTORS`          | 500 to 900 tokens   |
| **Markdown (Restrictor)** (default) | `output=md`                           | `MARKDOWN_RESTRICTORS` | about the same      |
| **Markdown (Raw)**                  | `output=md`                           | none                   | 2,000 to 23,000     |

SerpApi's Markdown output renders the kept fields as headings, lists and tables, without JSON's keys, quotes and braces. With the same fields, it is about 27% smaller than JSON across the seven example questions. Markdown mode spends that saving on data. `MARKDOWN_RESTRICTORS` keeps more items and more fields per tool, such as opening hours for places, related articles for news, legroom for flights, and a description for hotels, and lands near the JSON token count.

Markdown (Raw) is the whole document SerpApi renders. Most single questions fit a 32K window, from about 2,000 tokens for Flights to about 16,000 for Shopping. A Finance page is about 23,000 tokens and, with the system prompt and the tools, passed 32K on three of the four tested models. Comparing two stocks took 44,000 to 61,000. Reading that much takes minutes on a laptop, so this mode gets longer timeouts.

In Markdown mode, SerpApi puts `search_metadata` in a YAML block at the top of the document. The server takes the search URL out of it for the sources list and gives the model the rest, the same way JSON mode drops `search_metadata`. The setting applies from the next question and is saved in the browser.

The `serpapi` npm SDK (2.x) has only `getJson` and `getHtml`, so the Markdown path calls `https://serpapi.com/search` with `fetch`, with the same parameters plus `output=md`.

### Benchmark page (dev only)

`bun run dev` also serves [/bench](http://localhost:3005/bench), linked from the Benchmark button in the chat header. It compares the three output modes on the example questions. The route returns 404 in production, and every benchmark server function checks `import.meta.env.DEV` too, so a production build cannot spend SerpApi credits or write files.

- **Payload size.** One SerpApi call per tool per mode (28 credits) and no model. It also measures the full JSON response with no restrictor, which the model never receives, and shows tokens, bytes and fetch time for each.
- **End to end.** Runs each selected question in each selected mode through the full agent with the selected model, one cell at a time, each in a fresh conversation. Each cell shows LM Studio's input and output tokens for the whole turn, the time, and the tools called. Click a cell to see the answer, the time per phase and the tool arguments. A failed cell counts as a failure, never as zero tokens. Correctness is not scored.

Pick several models in the model picker to run them one after another, in the order you picked them. Each gets its own results file, and Stop also cancels the models still waiting. A run is a job on the dev server, so reloading the page or editing code does not lose it. The page reconnects to a run in progress and can stop it after the current cell. Each run saves after every cell to `bench/results/<timestamp>-<name>.json`, which is gitignored, so your runs stay on your machine.

Badges on a cell:

- **retried.** The model wrote no answer after the search, or LM Studio couldn't parse its reply twice, and the agent asked once more with the search results as plain text.
- **N rounds.** The model searched again after reading the results, to check an answer it had or to fix a search that missed. Every call carries the tools, up to 3 rounds; after the third, the answer call goes without them.
- **cut off.** The answer stopped at the 4,096-token limit. On models that think before answering, the thinking counts against that limit.
- **over context.** Older runs only. The prompt was larger than the loaded window, and an MLX model ran it anyway. The agent now stops these turns instead.

## Scripts

```bash
bun run dev         # start the dev server on :3005
bun run build       # production build
bun run start       # serve the production build at http://127.0.0.1:3000 (reads .env)
bun run typecheck   # tsc --noEmit
bun run lint        # eslint
bun run test        # vitest run (unit tests)
bun run format      # prettier --write
```

There is no CI. Run `bun run typecheck`, `bun run lint` and `bun run test` before you commit.

## Files

| Path                          | Purpose                                                                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/server/agent.ts`         | Tools, Zod schemas, SerpApi calls, token counting, model loading, and `runAgentTurn`, one full agent turn. The SerpApi key never leaves here.                                  |
| `src/server/models.ts`        | The model list server function, `listModels`. The routes import it instead of `agent.ts`.                                                                                      |
| `src/server/restrictors.ts`   | The `json_restrictor` strings for the seven engines: `RESTRICTORS` for JSON, `MARKDOWN_RESTRICTORS` for Markdown.                                                              |
| `src/server/chat.ts`          | Chat server functions. The session and the turn runner live in `chat-session.server.ts`.                                                                                       |
| `src/server/bench.ts`         | Dev-only benchmark server functions and the saved-run schema. The runner lives in `bench-job.server.ts`.                                                                       |
| `src/server/tokens.server.ts` | Token estimates with tiktoken's `cl100k_base`. The `.server.ts` suffix keeps the 1 MB rank table out of the client build.                                                      |
| `src/routes/index.tsx`        | Chat page, token breakdown sidebar and latency panel.                                                                                                                          |
| `src/routes/bench.tsx`        | Benchmark page. Its components are in `src/components/bench/`.                                                                                                                 |
| `src/lib/agent-types.ts`      | Types and constants shared by client and server. Client code imports from here, so the SDKs never reach the browser bundle.                                                    |
| `src/components/ui/*`         | shadcn/ui components. `markdown.tsx` renders model output with shadcn/typeset (`src/typeset.css`).                                                                             |
| `src/**/__tests__/*`          | Unit tests for history handling, secret redaction, tool-call parsing, SerpApi errors, context sizing, chat sessions, benchmark math, the default model and Markdown rendering. |
| `.env.example`                | Environment variable template.                                                                                                                                                 |

## Security

Only `src/server/agent.ts` reads `SERPAPI_API_KEY`, and only in code that runs on the server. Routes never import it. They call server functions in `chat.ts`, `bench.ts` and `models.ts`, which the client build replaces with RPC stubs. `agent.ts` imports `@tanstack/react-start/server-only`, so the build fails if a route or component imports it, or if the SerpApi SDK would reach the browser. The app never logs the key. In development, the query log in `measurements/benchmark_log.json` removes likely secrets before it saves a query; a production build keeps no log. `bun run start` listens on 127.0.0.1 only. Set `NITRO_HOST` to serve other machines, and keep in mind that anyone who reaches the app spends your SerpApi searches.

## Notes

### Why one tool per engine instead of one `search(engine, query)`

Small models, around 4B to 9B, pick a tool by name reliably, but often set a parameter like `engine` wrong. One tool per engine (`google_search`, `google_news_search` and the rest) removes that class of error, at the cost of a few more tool definitions.

### Why `json_restrictor` matters

A raw SerpApi response runs from 3,000 to more than 50,000 tokens depending on the engine, and a 9B model with a 32K window cannot fit the large ones. With a `json_restrictor`, SerpApi returns only the fields you list, such as the top five organic results, the summary block and a few headlines. The sidebar shows the saving on every query.

### Why raw JSON stays out of the "Context used" total

The model only receives the restricted response. The app fetches the full response only for the comparison view and counts it separately. Adding it to the total would be wrong, because the model never reads it.

That comparison is usually one more SerpApi search per tool call: SerpApi serves a search from its cache only when every parameter matches a search from the last hour, and the comparison drops `json_restrictor`. So the app runs it only when you click "Compare with the full response", at most once per answer, and the sidebar counts it under "Full-response checks", next to the searches the model ran.

### How multi-turn chat fits the window

Every turn sends the conversation so far back to the model, which is how OpenAI and Anthropic document tool use. The chat session on the server keeps that history.

Before each turn, the server removes earlier tool calls and raw tool results, which are large, and keeps every answer the model wrote. Answers that came from a search carry a note saying their prices, scores, news and opening hours may be out of date. The model can then follow "which of those has the best rating?" or "put the plan together", while the system prompt tells it to search again for anything that changes. Small models otherwise tend to repeat an old answer, such as yesterday's flight prices, as if it were fresh.

When the history and the new turn would pass about 70% of the loaded window, the server drops the oldest turns until it fits. The chat header shows "N turns of history", the questions and answers sent again with each new question, and "N older turns dropped to fit" once trimming starts. A turn that failed is not kept. A turn that ended without an answer keeps its question, with a short reply saying the model couldn't find the answer, so a follow-up like "their prices" still knows the subject. Clear chat starts a new session, and its Undo goes back to the old one.

The conversation lives on the server, not in the browser tab. A turn runs in the background while the page polls its progress, so reloading the page, closing the tab or an HMR update does not lose the question or the answer. An httpOnly cookie names the session. The server keeps up to 20 sessions in memory, each for a day after its last use, and restarting the server starts a fresh chat.

### Where the token numbers come from

"Context used" is LM Studio's own count for the turn's last call: the prompt it read and the output it wrote, from the model's tokenizer and chat template. Every chat completion returns it in `usage`, with the reasoning share in `completion_tokens_details.reasoning_tokens`. The output side includes that reasoning, so it can be much larger than the visible answer.

A completion's `usage` reports totals, not parts. The parts under the total (tool definitions, system prompt, history, tool calls, tool results) are measured with tiktoken's `cl100k_base` and scaled so they add up to LM Studio's number, and the panel marks them with "~". On the same text, cl100k counts up to 7% fewer tokens than the models' own tokenizers: the system prompt is 923 tokens in cl100k, 956 on Qwen 3.8 27B and 983 on Gemma 4 12B. The chat template adds more. The tool definitions measured 1,646 tokens with cl100k, and 1,862 on Gemma and 2,092 on Qwen once the template had rendered them into the prompt. That gap is also why history trimming, which runs before LM Studio has counted anything, starts at 70% of the window. `o200k_base`, the encoding of OpenAI's newer models, came within 1% of cl100k on each of these texts, so it would not change the split: neither is a local model's tokenizer. LM Studio counts a prompt by rendering the chat template and running the model's tokenizer over it; its TypeScript SDK's [`applyPromptTemplate` and `countTokens`](https://lmstudio.ai/docs/typescript/tokenization) reproduced `prompt_tokens` to within one token on Gemma 4 12B. Counting each part that way would make the parts exact too, at the cost of a second LM Studio client next to the OpenAI-compatible one.

The answer call after the last round sends no tools, so the breakdown shows no tool definitions for it. With `tool_choice: "none"` the prompt would be the same: LM Studio leaves the tool definitions out of it. "This turn" adds up every call of the answer: each one reads the conversation again. "Next question starts at" is what the next question will carry, since search results are not kept between questions.
