# SerpApi Local Agent Lab

A chat app that lets a model running on your own computer search the web. You ask a question, the model decides what to search for, the app runs that search through SerpApi, and the model answers from the results. If the first search isn't enough, the model can search again, up to three times.

The model runs in LM Studio on your machine. The only thing that leaves it is the search query.

This is the companion code for the SerpApi article [How to Connect Your Local LLM with Web Search Data](https://serpapi.com/blog/how-to-connect-your-local-llm-with-web-search-data/).

## What you need

- [Bun](https://bun.sh) 1.3 or newer.
- [Node.js](https://nodejs.org) 22.12 or newer. Bun uses it to run Vite and `bun run start`.
- [LM Studio](https://lmstudio.ai) with its server running on port 1234, and a model that supports tool calls. See [Pick a model](#pick-a-model).
- A [SerpApi](https://serpapi.com) account and API key.

## Get started

```bash
bun install
cp .env.example .env   # then add your SERPAPI_API_KEY
bun dev
```

Open http://localhost:3005 and ask something like "What's the current price of AAPL stock?". You don't need to load the model in LM Studio first. The app loads the one you pick.

## How it works

1. You send a question. The server passes it to the model along with seven search tools, one per Google engine.
2. The model calls a tool. The server runs that search with SerpApi and sends the results back to the model.
3. The model answers, or searches again to check its answer or fix a search that missed. After the third search round, it has to answer.

Local models have small context windows, so the app keeps search results short. SerpApi's [`json_restrictor`](https://serpapi.com/json-restrictor) parameter trims each response on SerpApi's side, so the model only gets the fields it needs, such as the top five organic results. You can also ask SerpApi for [Markdown output](https://serpapi.com/markdown-output) instead of JSON. See [JSON or Markdown](#json-or-markdown).

While a question runs, the app shows what the model is doing (loading, thinking, searching, writing) and how long each step took. After the answer, it shows:

- the search result pages the model used, as links under the answer
- how many tokens the model read and wrote, split into system prompt, tools, history and search results
- how many SerpApi searches the chat has used

The SerpApi key stays on the server and never reaches the browser. See [Security](#security).

## Search tools

| Tool                     | Example question                                               |
| ------------------------ | -------------------------------------------------------------- |
| `google_search`          | Who won the last F1 race?                                      |
| `google_finance_search`  | What's the current price of AAPL?                              |
| `google_news_search`     | Latest news about AI regulation                                |
| `google_maps_search`     | Barbecue restaurants in Austin, Texas                          |
| `google_flights_search`  | Flights from SCL to MAD two months from today                  |
| `google_hotels_search`   | Hotels in Barcelona for two adults, three nights in two months |
| `google_shopping_search` | Best price for AirPods Pro                                     |

## Pick a model

These four models answered all 13 benchmark questions in every output mode. LM Studio lists them as staff picks for a 48 GB Mac.

| Model                 | LM Studio ID             | Format | Time for the 7 search questions (Markdown) |
| --------------------- | ------------------------ | ------ | ------------------------------------------ |
| Qwen 3.8 27B          | `qwen/qwen3.8-27b`       | MLX    | 278 s                                      |
| Meta Muse Glimmer 28B | `meta/muse-glimmer`      | GGUF   | 420 s                                      |
| Prism Bonsai 27B      | `prism-ml/bonsai-27b`    | MLX    | 153 s                                      |
| Gemma 4 12B QAT       | `google/gemma-4-12b-qat` | GGUF   | 105 s                                      |

- **Qwen 3.8 27B** is the default when it's installed. In long conversations it was the best at turning follow-ups like "around there" or "which of those" into the right search.
- **Gemma 4 12B QAT** is the fastest and needs the least memory, so start with it on a smaller machine. It also makes most of the mistakes listed in [Known limitations](#known-limitations).
- Models below 7B often pick the wrong tool or make up arguments.

### Hardware

The app was tested with LM Studio 0.4.25 on a MacBook Pro M4 Max with 36 GB of RAM and a MacBook Pro M5 Pro with 48 GB. The times in the table come from the 48 GB Mac. Smaller machines were not tested.

The model and its context window have to fit in memory, which means RAM on a Mac and VRAM on a PC with a discrete GPU. If they don't fit, the app loads the model with a smaller window. See [Context window](#context-window).

## JSON or Markdown

The output picker, next to the model picker, sets what SerpApi sends the model. Your choice is saved in the browser and applies from the next question.

| Mode                           | What the model reads                    | Size per search   |
| ------------------------------ | --------------------------------------- | ----------------- |
| JSON (Restrictor)              | Trimmed JSON                            | 500 to 900 tokens |
| Markdown (Restrictor), default | Trimmed Markdown, with more fields kept | About the same    |
| Markdown (Raw)                 | The whole page SerpApi renders          | 2,000 to 23,000   |

With the same fields, Markdown is about 27% smaller than JSON, because it has no keys, quotes or braces. The Markdown mode uses that room for more data, such as opening hours for places and legroom for flights, so both restricted modes end up close in size.

Markdown (Raw) is as big as the live page. Most questions fit in a 32K window, but Finance pages vary a lot. Comparing AAPL and TSLA has come to anywhere from 15,000 to 64,000 tokens, and reading that much takes minutes on a laptop.

## Context window

LM Studio loads a model with an 8,192-token context window unless you ask for more. That's too small for a chat that carries search results, so the app loads the model itself:

1. It asks for 32,768 tokens, or the model's maximum if that's smaller.
2. If LM Studio says the model won't fit in memory, the app tries smaller sizes until one loads.
3. The sidebar shows the size it got, and the app trims older chat history to fit it.

To skip this and use a fixed size, set `LMSTUDIO_CONTEXT_LENGTH`.

The app keeps one model loaded at a time. Picking another model unloads the first one, and an idle model unloads after five minutes.

## Configuration

Set these in `.env`. Only the SerpApi key is required.

| Variable                  | Default                 | What it does                                                                                    |
| ------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------- |
| `SERPAPI_API_KEY`         | none                    | Your SerpApi key. Get one at https://serpapi.com/manage-api-key.                                |
| `LMSTUDIO_URL`            | `http://localhost:1234` | Where the LM Studio server runs.                                                                |
| `LMSTUDIO_CONTEXT_LENGTH` | unset                   | Load the model at this many tokens instead of finding the largest size that fits.               |
| `LMSTUDIO_TTL_SECONDS`    | `300`                   | How long an idle model stays loaded, in seconds.                                                |
| `LMSTUDIO_API_KEY`        | unset                   | A token from LM Studio's Developer page. Needed only if **Require Authentication** is on there. |

Two LM Studio settings also matter:

- Keep **Model loading guardrails** on (Settings, Hardware). They're how the app finds out a model won't fit.
- On a GPU with little VRAM, turning off **Offload KV cache to GPU memory** lets larger windows fit, at the cost of slower answers.

## Troubleshooting

| Problem                                                           | What to try                                                                                                                                                 |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Failed to fetch http://localhost:1234/v1/models`                 | LM Studio's server is off. Start it from LM Studio (Developer, Start Server), then check with `curl http://localhost:1234/v1/models`.                       |
| `SerpApi request failed: Invalid API key`                         | Check `SERPAPI_API_KEY` in `.env`, then restart `bun dev`. The app only reads `.env` at startup.                                                            |
| `bun dev` starts on a port other than 3005                        | Something else is using port 3005, so Vite took the next free port. Open the URL it prints, or stop the other process (`lsof -i :3005`, then `kill <pid>`). |
| `bun run start` fails with `EADDRINUSE`                           | Something else is using port 3000. Stop it (`lsof -i :3000`, then `kill <pid>`), or pick another port with `PORT=3001 bun run start`.                       |
| The model picks the wrong tool or makes up arguments              | Use one of the models in [Pick a model](#pick-a-model).                                                                                                     |
| The chat forgets things fast, or the loaded size is 8,192 or less | The model didn't fit at a larger size. Try a smaller model. See [Context window](#context-window).                                                          |
| `LM Link connection entered error state peer_keepalive_timeout`   | The machine running the model through LM Link went to sleep or lost its network. Keep it awake, then try again.                                             |

## Known limitations

These came up in long test conversations, mostly with Gemma 4 12B QAT, and are not fixed.

- **Wrong language.** After the user mentions a city like Montevideo, Gemma starts searching in Spanish and answers English questions in Spanish, even though the system prompt asks it to use the user's language.
- **Made-up prices.** Asked for the best price of a Ryzen 7 9800X3D, Gemma gave a "typical market price" that wasn't in the search results.
- **Ambiguous questions.** "Whats the score of the real madrid game" returned the women's team's result without saying so. Gemma used news search instead of web search, which is where Google shows live scores.
- **Large raw pages.** In Markdown (Raw), a Finance question or a weather search can be bigger than a 32K window. A Madrid forecast came to 34,418 tokens. The app stops the turn and shows the prompt size, but only after the model has read the whole prompt, which took Qwen 3.8 27B 155 seconds.

## Benchmark page

When you run `bun dev`, the app also serves [/bench](http://localhost:3005/bench), linked from the Benchmark button in the chat header. It only exists in development, so a production build can't spend SerpApi credits from it.

- **Payload size** runs one search per tool for each mode, plus the full JSON response with no restrictor (28 searches in all), and compares their sizes. It doesn't use a model.
- **End to end** sends each question you pick through the full agent with each model you pick, in a fresh conversation every time. It shows tokens, time and the tools called for each one. It doesn't check whether the answers are right.

A run keeps going if you reload the page. Results are saved to `bench/results/`, which git ignores.

## Scripts

```bash
bun run dev         # start the dev server on :3005
bun run build       # production build
bun run start       # serve the production build at http://127.0.0.1:3000 (reads .env)
bun run typecheck   # tsc --noEmit
bun run lint        # eslint
bun run test        # vitest run (unit tests)
bun run format      # prettier --write on .ts, .tsx, .js and .jsx files
```

There's no CI, so run `bun run typecheck`, `bun run lint` and `bun run test` before you commit.

## Where things live

| Path                             | What's in it                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/agent.server.ts`     | The agent: tools, SerpApi calls, model loading and `runAgentTurn`. The only file that reads the SerpApi key.                        |
| `src/server/restrictors.ts`      | The `json_restrictor` strings for each engine, for JSON and for Markdown.                                                           |
| `src/server/chat.functions.ts`   | Server functions for the chat. The session itself is in `chat-session.server.ts`.                                                   |
| `src/server/models.functions.ts` | The server function that lists models.                                                                                              |
| `src/server/bench.functions.ts`  | Server functions for the benchmark page. `bench-job.server.ts` runs the benchmark, and `bench-runs.server.ts` saves and loads runs. |
| `src/routes/index.tsx`           | The chat page.                                                                                                                      |
| `src/routes/bench.tsx`           | The benchmark page. Its components are in `src/components/bench/`.                                                                  |
| `src/lib/agent-types.ts`         | Types and constants shared by the browser and the server.                                                                           |
| `src/components/ui/*`            | shadcn/ui components.                                                                                                               |
| `src/**/__tests__/*`             | Unit tests.                                                                                                                         |

## Security

- Only `src/server/agent.server.ts` reads `SERPAPI_API_KEY`, and it only runs on the server. If any browser code imports it, the build fails.
- The app never logs the key. The development query log removes anything that looks like a secret, and a production build keeps no log.
- `bun run start` only listens on 127.0.0.1. Set `NITRO_HOST` to open it to other machines, but anyone who can reach the app can spend your SerpApi searches.

## More detail

[docs/how-it-works.md](docs/how-it-works.md) covers the parts most people won't need: how the context window is sized, how chat history is trimmed, where the token numbers come from, what the benchmark badges mean, and why the app has one tool per engine.
