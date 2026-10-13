// Model list server function. The LM Studio code lives in `agent.ts`; only
// the handler uses it, so the client build, which replaces the handler with
// an RPC stub, drops the import with it.

import { createServerFn } from "@tanstack/react-start"

import { readModels } from "./agent"
import type { ModelInfo } from "@/lib/agent-types"

/** Every LLM LM Studio knows about, with a recommended context size. */
export const listModels = createServerFn({ method: "GET" }).handler(
  (): Promise<Array<ModelInfo>> => readModels()
)
