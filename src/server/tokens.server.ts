import { Tiktoken } from "js-tiktoken/lite"
import cl100k_base from "js-tiktoken/ranks/cl100k_base"

// ─── Token counting ────────────────────────────────────
// tiktoken's cl100k_base (the GPT-4 encoding) is a stand-in for the real
// model tokenizer. The exact counts come from LM Studio's API when a call
// runs; cl100k is a consistent ruler for comparing segments offline.
//
// WHY: a `.server.ts` file. TanStack Start's import protection removes
//      these files from the client build outright, so the 1 MB rank table
//      can never reach the browser, however the bundler tree-shakes the
//      modules that import it. The `lite` entry plus one rank file keeps
//      the server chunk small too; the package's main entry pulls in every
//      encoding.

let encoding: Tiktoken | null = null

/**
 * Estimate token count for a string or JSON-serialisable value using the
 * GPT-4 encoding. Used for the per-segment breakdown in the UI.
 */
export function countTokens(value: unknown): number {
  encoding ??= new Tiktoken(cl100k_base)
  const text = typeof value === "string" ? value : JSON.stringify(value)
  // WHY: by default the encoder throws on special-token text such as
  //      `<|endoftext|>`, which a question about tokenizers or a search
  //      result can contain. Count it as plain text instead.
  return encoding.encode(text, [], []).length
}
