# AGENTS.md

Guidance for coding agents working in this repository. Humans: the README covers setup and usage; this file covers conventions and where things live.

## What this is

A TanStack Start app that gives a local LLM (served by LM Studio) seven SerpApi tools through OpenAI-style function calling. Every SerpApi response is trimmed server-side with `json_restrictor`, except in Markdown Raw, where the model reads the whole page. The chat UI lives at `/`; a dev-only benchmark page at `/bench` compares the three tool-output modes (JSON, Markdown, Markdown Raw).

## Stack and versions

- Bun 1.3+ as package manager and script runner.
- TanStack Start 1.169+ and Router 1.170+ (file routes in `src/routes`, generated tree in `src/routeTree.gen.ts`, never hand-edited).
- React 19.3, TypeScript 5.9 (strict), Vite 8, Vitest 5, Tailwind CSS 4.3.
- shadcn/ui components in `src/components/ui`, style `radix-nova`, `cn` from `@/lib/utils` (which re-exports the `cn` package). Markdown typography comes from shadcn/typeset (`src/typeset.css`), not `@tailwindcss/typography`.
- Zod 4 for every runtime boundary (tool args, server-function input, saved benchmark files).
- `openai` SDK 7 pointed at LM Studio's `/v1`; LM Studio's native `/api/v1` for list/load/unload.

Run before committing: `bun run typecheck`, `bun run lint`, `bun run test`. There is no CI. Use `bun run format` to apply Prettier (it also sorts Tailwind classes).

## Layout

| Path                                | Role                                                                                                                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/server/agent.server.ts`        | Server code. Tools, Zod schemas, SerpApi executors, model load/unload lifecycle, `runAgentTurn` and `readModels`. The `.server.ts` suffix makes the build fail if a route or component imports it.     |
| `src/server/models.functions.ts`    | The server function `listModels`, which the routes import.                                                                                                                                             |
| `src/server/tokens.server.ts`       | `countTokens` (cl100k estimate). The `.server.ts` suffix makes the build fail if a route or component imports it.                                                                                      |
| `src/server/restrictors.ts`         | The `json_restrictor` strings per engine: `RESTRICTORS` (tight, JSON mode) and `MARKDOWN_RESTRICTORS` (more fields at about the same token count). Markdown (Raw) sends none.                          |
| `src/server/chat.functions.ts`      | Chat server functions (`getChatSession`, `getChatStatus`, `sendChatMessage`, `clearChatSession`, `restoreChatSession`, `measureFullResponses`) and `chatQueries`.                                      |
| `src/server/chat-session.server.ts` | In-memory chat sessions named by an httpOnly cookie, the background turn runner, and the chat's SerpApi search count. The page polls it; it never runs a turn from the browser.                        |
| `src/server/bench.functions.ts`     | Dev only. Job server functions (`startBenchJob`, `queueBenchJobs`, `getBenchJob`, `stopBenchJob`), `saveBenchRun`, `listBenchRuns`, the `devOnly` middleware and `benchQueries`.                       |
| `src/server/bench-runs.server.ts`   | Saved runs in `bench/results/`. Writes them atomically, reads them back, and upgrades version 1 files to the current format.                                                                           |
| `src/server/bench-job.server.ts`    | The benchmark job runner and queue. Writes the run file after every cell.                                                                                                                              |
| `src/lib/agent-types.ts`            | Browser-safe types and constants shared by client and server (`ToolOutput`, `ModelInfo`, `Breakdown`, `TOOL_OUTPUT_META`, `CONTEXT_SEGMENTS`). Client code imports from here.                          |
| `src/lib/chat.ts`                   | Browser-safe chat session types (`ChatSession`, `ChatMessage`, `ChatTurnStats`) and `chatTurnInput`, the schema `sendChatMessage` validates.                                                           |
| `src/lib/bench-schemas.ts`          | Browser-safe Zod schemas and types for saved runs (versioned), the job and the input that starts one.                                                                                                  |
| `src/lib/bench.ts`                  | Browser-safe benchmark math: payload calls, roll-ups, deltas, formatting.                                                                                                                              |
| `src/lib/restrictor-diff.ts`        | Finds what the JSON Restrictor kept. JSON walks both trees; Markdown is aligned section by section with a longest common subsequence.                                                                  |
| `src/lib/models.ts`                 | `pickDefaultModel`: Qwen 3.8 27B, then any Qwen, then any tool-trained model.                                                                                                                          |
| `src/lib/examples.ts`               | The example questions, one per engine, plus no-tool and parallel-call cases.                                                                                                                           |
| `src/components/theme-provider.tsx` | Light/dark theme with localStorage persistence and the `d` shortcut, mounted in `__root.tsx`. Read it with `useTheme` from `src/hooks/use-theme.ts`.                                                   |
| `src/components/model-selector.tsx` | The model picker shared by `/` and `/bench`.                                                                                                                                                           |
| `src/components/context-window.tsx` | The token breakdown's context window. A field of cells shows what filled the last call; hovering a part lights it up, and the tool result opens into one row per search that opens the inspect dialog. |
| `src/components/response-view.tsx`  | A SerpApi response in the inspect dialog. Markdown shows as source or rendered with TanStack Markdown, JSON is highlighted with TanStack Highlight, and the parts the restrictor kept are marked.      |
| `src/components/route-states.tsx`   | Not-found, loading and error screens for the routes. `RouteError` is the router's `defaultErrorComponent`.                                                                                             |
| `src/components/command-menu.tsx`   | Cmd/Ctrl+K command menu (pages, theme), mounted in `__root.tsx` next to the Sonner `Toaster`.                                                                                                          |
| `src/routes/index.tsx`              | Chat page: messages, token breakdown sidebar, latency panel, restrictor dialog.                                                                                                                        |
| `src/routes/bench.tsx`              | Benchmark page. Owns run state; renders the components in `src/components/bench`.                                                                                                                      |
| `src/components/bench/*`            | Payload tier table, end-to-end matrix with per-mode summary, cell inspector sheet, saved-runs panel, header.                                                                                           |
| `src/components/ui/markdown.tsx`    | `react-markdown` wrapped in `typeset` with a preset (`typeset-chat` default, `typeset-compact` for dense views). Fenced code renders through Shiki and opts out with `not-typeset`.                    |
| `bench/results/*.json`              | Saved benchmark runs, written by `/bench`. Gitignored: every machine and model produces its own numbers, so none ship with the repo.                                                                   |
| `measurements/benchmark_log.json`   | Append-only log of the chat and `/bench` agent turns that finish without an error, written in development only. Gitignored.                                                                            |

## Rules that matter here

**Server/client boundary.** `src/server` follows the file organization in TanStack Start's [server functions guide](https://tanstack.com/start/latest/docs/framework/react/guide/server-functions#file-organization). `*.functions.ts` files export the server functions (`createServerFn`) with their middleware and query options, and they are the only `src/server` modules the browser imports. `*.server.ts` files hold the server-only code those handlers call. Shared Zod schemas and the types inferred from them are in plain modules under `src/lib` (`chat.ts`, `bench-schemas.ts`). Anything the browser renders takes its types and constants from `src/lib`, such as `agent-types.ts` for the agent. In the client build, TanStack Start replaces each handler with an RPC stub and strips the `.validator()` calls, then removes the declarations and imports that only the removed code used. Everything else the file exports, and any top-level call, stays in the compiled client module with the imports it uses. So limit each `*.functions.ts` file to server functions, their middleware and their query options. Import `*.server.ts` modules statically and call them only inside handlers, never with `await import()`. Read environment variables inside functions, never at module scope. Configure SDKs on first use, as `configureSerpApi` does. Import protection fails `bun run build` if a client-reachable import of a `*.server.ts` file, or of the `serpapi`, `openai` or `js-tiktoken` package, survives compilation and tree-shaking. `bun run dev` only logs a warning and replaces the import with a mock. The package rule is in `vite.config.ts`. After you change `agent.server.ts`, run the build and check that no `bpe_ranks` or `serpapi.com` string appears under `.output/public/assets/`.

**Long work runs on the server, not in the tab.** A chat turn and a benchmark run both start as background work on the server; the page starts it, polls a small status, and reads the result back, so a reload, a closed tab or an HMR update never loses it. Keep that state on `globalThis` (HMR swaps modules mid-run) and never make the browser the only holder of something slow to produce. Pages read that state through TanStack Query: the query factories `chatQueries` and `benchQueries` sit next to their server functions, loaders fill the cache with `context.queryClient.query()`, polling uses `refetchInterval`, and a mutation writes the resource its server function returns with `setQueryData`. Don't copy server state into `useState`.

**Dev-only server functions must check for themselves.** Hiding a route in `beforeLoad` does not hide its server functions; they are reachable by URL. Every handler in `src/server/bench.functions.ts` runs through the `devOnly` middleware. Follow the same pattern for any new dev tooling.

**Validate at the boundary, don't assert.** Server-function input goes through `.validator(schema)` with the Zod schema itself: Zod 4 is a Standard Schema, so each call site is typed by the schema's input and the handler gets the parsed output. Files read from disk and JSON from LM Studio are parsed with Zod, not cast with `as`. Model result types are discriminated unions (`status: "completed" | "failed"`) so a failure cannot masquerade as a zero.

**Usage numbers.** `runAgentTurn` returns both `exactUsage` (the final completion's usage) and `totalUsage` (summed across every completion in the turn, `null` if any completion lacked usage). The benchmark compares `totalUsage`. The chat sidebar leads with `exactUsage` and scales the cl100k segments to it with `fitBreakdown`, since LM Studio reports totals, never parts. Never substitute zero for an unknown; render a dash.

**Model lifecycle.** `beginQuery()` / `endQuery()` bracket every `runAgentTurn`. The idle-unload timer only arms when no query is in flight. Do not call the load endpoint with a `ttl` field; LM Studio rejects it. Step down to a smaller context only when LM Studio refuses a load with "insufficient system resources"; show any other load failure as it is. Budget against the smaller of the requested and applied context (`echo_load_config`), and fail a turn whose prompt is over that budget, because MLX models run it anyway. A turn fails fast when another turn is using a different model, because loading one unloads the rest. The load records, the in-flight count, the idle timer and query progress live on `globalThis`. These rules were tested against LM Studio 0.4.25; re-test against a real LM Studio before changing them.

**Copy.** Sentence case, plain verbs, no em-dashes anywhere (use a comma, colon, or a new sentence). Labels say what the user sees, not how the system is built. Failures explain what happened and what to do next.

**Descriptions only when strictly necessary.** A title, a label, or the data itself usually says enough. Add a description, tooltip, or footnote only when the element cannot be understood without it, and then use one short sentence. "The model should answer without calling SerpApi." is complete; explaining why that matters, what it implies for token counts, or how to interpret it is bloat. Do not restate what a column header or a number already shows. If you are unsure whether a sentence is needed, delete it.

**Design.** Match the chat page: shadcn `Card` sections on a `bg-muted/40` canvas, Inter, `font-mono tabular-nums` for every number, SerpApi brand colors (`serpapi-blue`, `serpapi-purple`, `serpapi-violet`) reserved for meaning (progress, phases, active state), never decoration. Motion only in response to user actions. Every interactive element has a visible focus ring and a label.

**Every control is a `Button`.** Buttons, menu triggers, and popover triggers all render `Button`, and get their height, radius, font size, weight, fill, and hover from `size` and `variant`; the call site only adds color or layout classes (`text-muted-foreground`, `shrink-0`). There is no Select primitive: a picker is a `Popover` laid out like the Examples popover, with an outline `Button` trigger, a title, group headings, and one ghost `Button` per option. Controls that sit in one row share one `size` (the composer uses `lg`). If the primitive lacks the shape you need, add a variant in `src/components/ui/button.tsx`, once. An ESLint rule (`eslint.config.js`) fails the build on `h-*`, `rounded-*`, `text-*`, or `font-*` in a Button's `className`. Icons inside a Button carry `data-icon="inline-start"` or `"inline-end"` so the primitive's padding adjusts.

## Adding a SerpApi tool

1. Add the name to `RESTRICTOR_TOOLS` and a restrictor string to both `RESTRICTORS` and `MARKDOWN_RESTRICTORS` in `src/server/restrictors.ts`.
2. Add a Zod schema, a `TOOLS` entry, and a `toolParams` case in `src/server/agent.server.ts`. The compiler enforces the `Record<RestrictorTool, ...>` maps.
3. Add an example in `src/lib/examples.ts` and a payload call in `src/lib/bench.ts`.
4. Extend `toolCallLabel` (server) and its client twin in `restrictor-dialog.tsx`.
5. Add tests in `src/server/__tests__/agent.test.ts` for the args schema and params.
