# How it works

The [README](../README.md) covers setup and everyday use. This page explains the details behind it, for anyone changing the code or reading the numbers closely.

## The agent loop

Every call to the model carries the seven search tools, so after reading results the model can search again to check an answer or fix a search that missed. It gets up to three search rounds. The answer call after the third round goes without tools and tells the model it can't search again, which is the same rule LM Studio's own `.act()` uses for its last round.

Sometimes the model still writes a search instead of an answer, or LM Studio can't parse its reply twice in a row. Then the app asks once more and puts the search results in the message as plain text.

The app checks every tool argument with Zod. A bad argument in the first round ends the turn with an error that says what was wrong and what to try. In a later round, the model answers from the results it already has.

## Context window sizing

LM Studio loads a model with an 8,192-token window unless you ask for another size (before LM Studio 0.4.16 the default was 4,096). The right size depends on the machine. A 36 GB Mac fits far more than a 16 GB laptop, and a PC with a discrete GPU is limited by its VRAM, not its RAM. So the app doesn't guess. It lets LM Studio's memory guardrail decide and looks for the largest size it accepts.

`ensureModelLoaded` in `src/server/agent.server.ts` does this in four steps.

1. Start at 32,768 tokens, or the model's maximum if that's smaller. A bigger window doesn't make answers better, and on GGUF models LM Studio reserves memory for the whole window when it loads.
2. Load the model at that size with `POST /api/v1/models/load` and `echo_load_config: true`. LM Studio either loads it and returns the settings it applied, or refuses with HTTP 500, "insufficient system resources", and its memory estimate. A refusal takes under a tenth of a second, because nothing loads.
3. After a refusal, try 3/4, 1/2, 3/8, 1/4 and 1/8 of the starting size, then 4,096. Any other error, such as an unknown model, an engine error or a dropped LM Link connection, shows up right away with LM Studio's message, because a smaller size wouldn't fix it.
4. Use the smaller of the size requested and the size LM Studio applied. The app trims history to that window, and the sidebar shows it.

LM Studio's estimate accounts for the platform, so the same code works on Apple Silicon and on discrete GPUs. Here is a real run on a 48 GB MacBook Pro for `gemma-4-31b-qat`, starting at 131,072 tokens.

```
131072  refused (about 52.4 GB)
 98304  refused (about 43.9 GB)
 65536  loaded, the largest size that fits
```

`LMSTUDIO_CONTEXT_LENGTH` skips the search. The value has to be 4,096 or more, and the app rounds it down to a multiple of 1,024. If LM Studio refuses that size, the turn fails and shows LM Studio's estimate.

### MLX models pick their own window

On GGUF models the requested size is exact, and LM Studio rejects a longer prompt with `exceed_context_size_error`. LM Studio's MLX engine works differently. It fits the window to free memory and keeps the larger of that and the request. Asked for 32,768 tokens, Qwen 3.8 27B got 61,696 on a 36 GB Mac and 119,552 on a 48 GB one.

So after each call the app reads the model's own prompt count, and stops the turn if the prompt is bigger than the size it asked for. That way every model works within the same window.

### One model at a time

Each question unloads any other LLM before it loads the selected one, so the guardrail can use all the memory. Embedding models stay loaded. If you ask a question with another model while one is still answering, the question fails with a message that says so.

## LM Studio endpoints

The app uses two LM Studio APIs, both built from `LMSTUDIO_URL`.

- The native API (`/api/v1`) lists, loads and unloads models. The load request sends `model`, `context_length`, `flash_attention` and `echo_load_config`. LM Studio rejects a `ttl` key on that endpoint with HTTP 400, so the app never sends one.
- The OpenAI-compatible API (`/v1`) runs the chat completions.

When `LMSTUDIO_API_KEY` is set, the app sends it as `Authorization: Bearer` to both.

According to [LM Studio's docs](https://lmstudio.ai/docs/developer/core/ttl-and-auto-evict), models loaded through the API "do not have a TTL, and will remain loaded in memory until you manually unload them". So the app unloads them itself. After each question it starts a timer, five minutes by default, that unloads the model if nothing else comes in. `LMSTUDIO_TTL_SECONDS` changes the timer.

## Markdown output

The `serpapi` npm SDK (2.x) only has `getJson` and `getHtml`. For Markdown, the app calls `https://serpapi.com/search` with `fetch`, using the same parameters plus `output=md`.

In Markdown mode, SerpApi puts `search_metadata` in a YAML block at the top of the document. The server takes the search URL out of it for the sources list and drops the rest, the same way JSON mode drops `search_metadata`.

Markdown (Raw) gets longer timeouts, because reading a big page takes a local model minutes. Single questions range from about 2,000 tokens for Flights to about 17,000 for Shopping. The NVDA Finance page has measured anywhere from 9,000 to 23,000 tokens. At 23,000, with the system prompt and the tools added, it was too big for a 32K window on three of the four tested models.

## Chat history

Every turn sends the conversation so far back to the model, which is how OpenAI and Anthropic document tool use. The chat session on the server keeps that history.

Before each turn, the server removes earlier tool calls and search results, which are large, and keeps every answer the model wrote. That lets the model follow up on "which of those has the best rating?" without carrying old search pages. Answers that came from a search get a note saying their prices, scores, news and opening hours may be out of date, and the system prompt tells the model to search again for anything that changes. Without that, small models tend to repeat an old answer, like yesterday's flight prices, as if it were new.

When the history plus the new turn would take more than about 70% of the loaded window, the server drops the oldest turns until it fits. The chat header shows "N turns of history", meaning the questions and answers sent again with each new question, and "N older turns dropped to fit" once trimming starts.

- A turn that failed isn't kept.
- A turn that ended without an answer keeps its question, with a short reply saying the model couldn't find the answer. A follow-up like "their prices" still knows what it's about.
- Clear chat starts a new session, and its Undo brings back the old one.

The conversation lives on the server, not in the browser tab. A turn runs in the background while the page checks on its progress, so reloading the page, closing the tab or a hot reload doesn't lose the question or the answer. An httpOnly cookie identifies the session. The server keeps up to 20 sessions in memory, each for a day after it was last used, and restarting the server starts a fresh chat.

## Token numbers

"Context used" in the sidebar is LM Studio's own count for the last call of the turn, meaning the prompt the model read and the output it wrote. Every chat completion returns it in `usage`, with the reasoning share in `completion_tokens_details.reasoning_tokens`. The output count includes that reasoning, so it can be much bigger than the visible answer.

LM Studio only reports totals. The parts under the total (tool definitions, system prompt, history, tool calls, search results) are counted with tiktoken's `cl100k_base` and scaled so they add up to LM Studio's number. The sidebar marks them with "~" because they're estimates.

cl100k counts a bit low compared to the models' own tokenizers. The system prompt is 923 tokens in cl100k, 956 on Qwen 3.8 27B and 983 on Gemma 4 12B. The chat template adds more on top. The tool definitions are 1,646 tokens in cl100k, but 1,862 on Gemma and 2,092 on Qwen once the template renders them into the prompt. That gap is why history trimming, which runs before LM Studio has counted anything, starts at 70% of the window.

`o200k_base`, the encoding OpenAI's newer models use, came within 1% of cl100k on each of these texts, so switching wouldn't change the split. Neither one is a local model's tokenizer. The exact count would come from LM Studio's TypeScript SDK: [`applyPromptTemplate` and `countTokens`](https://lmstudio.ai/docs/typescript/tokenization) matched `prompt_tokens` to within one token on Gemma 4 12B. Using it would mean running a second LM Studio client next to the OpenAI-compatible one.

A few more things about the numbers:

- The answer call after the last round sends no tools, so its breakdown shows no tool definitions. With `tool_choice: "none"` the prompt would be the same, because LM Studio leaves the tool definitions out.
- "This turn" adds up every call in the answer, since each one reads the conversation again.
- "Next question starts at" is what the next question will carry, since search results aren't kept between questions.

### Full response size

The model only ever reads the restricted response. The sidebar can also show how big the full response would have been, but that usually costs one more SerpApi search per tool call. SerpApi only serves a search from its cache when every parameter matches a search from the last hour, and the comparison leaves out `json_restrictor`.

So the app only runs it when you click "Compare with the full response", at most once per answer. The sidebar counts these under "Full-response checks", next to the searches the model ran, and leaves the full size out of "Context used", because the model never reads it.

## Benchmark page

The `/bench` route returns 404 in production, and every benchmark server function also checks `import.meta.env.DEV`, so a production build can't spend SerpApi credits or write files.

You can pick several models in the model picker. They run one after another, in the order you picked them, and each gets its own results file. Stop also cancels the models still waiting. A run is a job on the dev server, so reloading the page or editing code doesn't lose it. The page reconnects to a running job and can stop it after the current cell. Each run saves after every cell to `bench/results/<timestamp>-<name>.json`.

A failed cell counts as a failure, never as zero tokens. Click a cell to see the answer, the time per phase and the tool arguments. The badges on a cell mean the following.

- **retried.** The model wrote no answer after the search, or LM Studio couldn't parse its reply twice, so the agent asked once more with the search results as plain text.
- **N rounds.** The model searched again after reading the results, to check an answer or fix a search that missed.
- **cut off.** The answer hit the 8,192-token output limit. On models that think before they answer, the thinking counts toward that limit.
- **over context.** Only in older runs. The prompt was bigger than the loaded window and an MLX model ran it anyway. The agent now stops these turns.

## Design notes

### One tool per engine

Small models, around 4B to 9B, are good at picking a tool by name but often get a parameter like `engine` wrong. Giving each engine its own tool (`google_search`, `google_news_search` and so on) removes that mistake, at the cost of a few more tool definitions.

### Why `json_restrictor`

A raw SerpApi response runs from 3,000 to more than 50,000 tokens depending on the engine, and a 9B model with a 32K window can't fit the large ones. With `json_restrictor`, SerpApi only returns the fields you list, such as the top five organic results, the summary block and a few headlines.

Google often leaves the AI Overview out of a web search and sends a token for it instead. When that happens, the agent fetches the overview with the token right away, which costs one more SerpApi search.

### How the key stays on the server

Routes never import `agent.server.ts`. They call the server functions in `chat.functions.ts`, `bench.functions.ts` and `models.functions.ts`, which the client build replaces with network calls. The build fails if browser code imports a `.server.ts` file, and a rule in `vite.config.ts` does the same for the SerpApi, OpenAI and tiktoken packages. The query log in `measurements/benchmark_log.json` only exists in development.
