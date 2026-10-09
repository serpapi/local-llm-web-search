# AGENTS.md

Guidance for coding agents working in this repository. Humans: the README covers setup and usage; this file covers conventions and where things live.

## What this is

A TanStack Start app that gives a local LLM (served by LM Studio) seven SerpApi tools through OpenAI-style function calling. Every SerpApi response is trimmed server-side with `json_restrictor`. The chat UI lives at `/`; a dev-only benchmark page at `/bench` compares the three tool-output modes (JSON, Markdown, Markdown Raw).

## Stack and versions

- Bun 1.3+ as package manager and script runner.
- TanStack Start 1.168+ and Router 1.170+ (file routes in `src/routes`, generated tree in `src/routeTree.gen.ts`, never hand-edited). `docs/tanstack-start.md` lists each documented Start and Router practice this app relies on and every place it departs from the docs on purpose; update it when you change routing, server functions or the build config.
- React 19.3, TypeScript 5.9 (strict), Vite 8, Vitest 5, Tailwind CSS 4.3.
- shadcn/ui components in `src/components/ui`, style `radix-nova`, `cn` from `@/lib/utils` (which re-exports the `cn` package). Markdown typography comes from shadcn/typeset (`src/typeset.css`), not `@tailwindcss/typography`.
- Zod 4 for every runtime boundary (tool args, server-function input, saved benchmark files).
- `openai` SDK 7 pointed at LM Studio's `/v1`; LM Studio's native `/api/v1` for list/load/unload.

Run before committing: `bun run typecheck`, `bun run lint`, `bun run test`. There is no CI. Use `bun run format` to apply Prettier (it also sorts Tailwind classes).

## Layout

| Path                                | Role                                                                                                                                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/server/agent.ts`               | Server code. Tools, Zod schemas, SerpApi executors, model load/unload lifecycle, `runAgentTurn`, and the server function `listModels`, which the routes import.                                                                       |
| `src/server/tokens.server.ts`       | `countTokens` (cl100k estimate). The `.server.ts` suffix makes import protection drop it from the client build.                                                                                                                       |
| `src/server/restrictors.ts`         | The `json_restrictor` strings per engine: `RESTRICTORS` (tight, JSON mode) and `MARKDOWN_RESTRICTORS` (more fields at about the same token count). Markdown (Raw) sends none.                                                         |
| `src/server/chat.ts`                | Chat server functions (`getChatSession`, `getChatStatus`, `sendChatMessage`, `clearChatSession`, `restoreChatSession`).                                                                                                               |
| `src/server/chat-session.server.ts` | In-memory chat sessions named by an httpOnly cookie, the background turn runner, and the chat's SerpApi search count. The page polls it; it never runs a turn from the browser.                                                       |
| `src/server/bench.ts`               | Server only, dev only. Job server functions (`startBenchJob`, `queueBenchJobs`, `getBenchJob`, `stopBenchJob`), `saveBenchRun`, `listBenchRuns`, and the versioned Zod schema for saved runs (with an upgrade path for the v1 shape). |
| `src/server/bench-job.server.ts`    | The benchmark job runner and queue. Writes the run file after every cell.                                                                                                                                                             |
| `src/lib/agent-types.ts`            | Browser-safe types and constants shared by client and server (`ToolOutput`, `ModelInfo`, `Breakdown`, `TOOL_OUTPUT_META`, `CONTEXT_SEGMENTS`). Client code imports from here.                                                         |
| `src/lib/chat.ts`                   | Browser-safe chat session types (`ChatSession`, `ChatMessage`, `ChatTurnStats`).                                                                                                                                                      |
| `src/lib/bench.ts`                  | Browser-safe benchmark math: payload calls, roll-ups, deltas, formatting.                                                                                                                                                             |
| `src/lib/models.ts`                 | `pickDefaultModel`: Qwen 3.8 27B, then any Qwen, then any tool-trained model.                                                                                                                                                         |
| `src/lib/examples.ts`               | The example questions, one per engine, plus no-tool and parallel-call cases.                                                                                                                                                          |
| `src/components/theme-provider.tsx` | Light/dark theme with localStorage persistence and the `d` shortcut, mounted in `__root.tsx`. Read it with `useTheme` from `src/hooks/use-theme.ts`.                                                                                  |
| `src/components/model-selector.tsx` | The model picker shared by `/` and `/bench`.                                                                                                                                                                                          |
| `src/components/route-states.tsx`   | Not-found, loading and error screens for the routes. `RouteError` is the router's `defaultErrorComponent`.                                                                                                                            |
| `src/components/command-menu.tsx`   | Cmd/Ctrl+K command menu (pages, theme), mounted in `__root.tsx` next to the Sonner `Toaster`.                                                                                                                                         |
| `src/routes/index.tsx`              | Chat page: messages, token breakdown sidebar, latency panel, restrictor dialog.                                                                                                                                                       |
| `src/routes/bench.tsx`              | Benchmark page. Owns run state; renders the components in `src/components/bench`.                                                                                                                                                     |
| `src/components/bench/*`            | Payload tier table, end-to-end matrix with per-mode summary, cell inspector sheet, saved-runs panel, header.                                                                                                                          |
| `src/components/ui/markdown.tsx`    | `react-markdown` wrapped in `typeset` with a preset (`typeset-chat` default, `typeset-compact` for dense views). Fenced code renders through Shiki and opts out with `not-typeset`.                                                   |
| `bench/results/*.json`              | Saved benchmark runs, written by `/bench`. Gitignored: every machine and model produces its own numbers, so none ship with the repo.                                                                                                  |
| `measurements/benchmark_log.json`   | Append-only log of every chat query. Gitignored.                                                                                                                                                                                      |

## Rules that matter here

**Server/client boundary.** Anything the browser renders imports types and constants from `src/lib/agent-types.ts`. From `src/server/*` it imports only server functions (`createServerFn`), never plain values. TanStack Start replaces each handler with an RPC stub in the client build and drops the imports only handlers used, but it keeps module-scope statements and every plain exported function, with everything they reference. So: import `*.server.ts` helpers statically and call them only inside handlers (as `chat.ts` and `bench.ts` do; never `await import()` them), wrap a plain export that reaches server-only code in `createServerOnlyFn` (`runAgentTurn`, `executeTool`), read environment variables inside functions, never at module scope, and keep heavy work lazy (see `configureSerpApi`). Import protection fails the build if a client-reachable path imports a `*.server.ts` file or the `serpapi`, `openai` or `js-tiktoken` package (the deny rule is in `vite.config.ts`; `trimHistoryToFit` takes the tokenizer as a parameter for this reason). After touching `agent.ts`, still run `bun run build` and confirm no `bpe_ranks` or `serpapi.com` string appears under `.output/public/assets/`.

**Long work runs on the server, not in the tab.** A chat turn and a benchmark run both start as background work on the server; the page starts it, polls a small status, and reads the result back, so a reload, a closed tab or an HMR update never loses it. Keep that state on `globalThis` (HMR swaps modules mid-run) and never make the browser the only holder of something slow to produce. Pages read that state through TanStack Query: the query factories `chatQueries` and `benchQueries` sit next to their server functions, loaders fill the cache with `context.queryClient.query()`, polling uses `refetchInterval`, and a mutation writes the resource its server function returns with `setQueryData`. Don't copy server state into `useState`.

**Dev-only server functions must check for themselves.** Hiding a route in `beforeLoad` does not hide its server functions; they are reachable by URL. Every handler in `src/server/bench.ts` runs through the `devOnly` middleware. Follow the same pattern for any new dev tooling.

**Validate at the boundary, don't assert.** Server-function input goes through `.validator(schema)` with the Zod schema itself: Zod 4 is a Standard Schema, so each call site is typed by the schema's input and the handler gets the parsed output. Files read from disk and JSON from LM Studio are parsed with Zod, not cast with `as`. Model result types are discriminated unions (`status: "completed" | "failed"`) so a failure cannot masquerade as a zero.

**Usage numbers.** `runAgentTurn` returns both `exactUsage` (the final completion's usage) and `totalUsage` (summed across every completion in the turn, `null` if any completion lacked usage). The benchmark compares `totalUsage`. The chat sidebar leads with `exactUsage` and scales the cl100k segments to it with `fitBreakdown`, since LM Studio reports totals, never parts. Never substitute zero for an unknown; render a dash.

**Model lifecycle.** `beginQuery()` / `endQuery()` bracket every `runAgentTurn`. The idle-unload timer only arms when no query is in flight. Do not call the load endpoint with a `ttl` field; LM Studio rejects it. Step down to a smaller context only when LM Studio refuses a load with "insufficient system resources"; show any other load failure as it is. Budget against the smaller of the requested and applied context (`echo_load_config`), and fail a turn whose prompt is over that budget, because MLX models run it anyway. A turn fails fast when another turn is using a different model, because loading one unloads the rest. The load records, the in-flight count, the idle timer and query progress live on `globalThis`. These rules were tested against LM Studio 0.4.25 on 2026-10-02; re-test against a real LM Studio before changing them.

**Copy.** Sentence case, plain verbs, no em-dashes anywhere (use a comma, colon, or a new sentence). Labels say what the user sees, not how the system is built. Failures explain what happened and what to do next.

**Descriptions only when strictly necessary.** A title, a label, or the data itself usually says enough. Add a description, tooltip, or footnote only when the element cannot be understood without it, and then use one short sentence. "The model should answer without calling SerpApi." is complete; explaining why that matters, what it implies for token counts, or how to interpret it is bloat. Do not restate what a column header or a number already shows. If you are unsure whether a sentence is needed, delete it.

**Design.** Match the chat page: shadcn `Card` sections on a `bg-muted/40` canvas, Inter, `font-mono tabular-nums` for every number, SerpApi brand colors (`serpapi-blue`, `serpapi-purple`, `serpapi-violet`) reserved for meaning (progress, phases, active state), never decoration. Motion only in response to user actions. Every interactive element has a visible focus ring and a label.

**Every control is a `Button`.** Buttons, menu triggers, and popover triggers all render `Button`, and get their height, radius, font size, weight, fill, and hover from `size` and `variant`; the call site only adds color or layout classes (`text-muted-foreground`, `shrink-0`). There is no Select primitive: a picker is a `DropdownMenu` (radio group) whose trigger is `Button variant="outline"`, exactly like the Examples popover. Controls that sit in one row share one `size` (the composer uses `lg`). If the primitive lacks the shape you need, add a variant in `src/components/ui/button.tsx`, once. An ESLint rule (`eslint.config.js`) fails the build on `h-*`, `rounded-*`, `text-*`, or `font-*` in a Button's `className`. Icons inside a Button carry `data-icon="inline-start"` or `"inline-end"` so the primitive's padding adjusts.

## Adding a SerpApi tool

1. Add the name to `RESTRICTOR_TOOLS` and a restrictor string to both `RESTRICTORS` and `MARKDOWN_RESTRICTORS` in `src/server/restrictors.ts`.
2. Add a Zod schema, a `TOOLS` entry, and a `toolParams` case in `src/server/agent.ts`. The compiler enforces the `Record<RestrictorTool, ...>` maps.
3. Add an example in `src/lib/examples.ts` and a payload call in `src/lib/bench.ts`.
4. Extend `toolCallLabel` (server) and its client twin in `restrictor-dialog.tsx`.
5. Add tests in `src/server/__tests__/agent.test.ts` for the args schema and params.
