import type { ModelInfo } from "@/lib/agent-types"

// Default model preference: Qwen 3.8 27B (the model tested most) > any
// Qwen > any tool-use trained model > first available.
export function pickDefaultModel(models: Array<ModelInfo>): ModelInfo | null {
  if (models.length === 0) return null
  const tested = models.find((m) => /qwen.*3\.?8.*27b/i.test(m.id))
  if (tested) return tested
  const anyQwen = models.find((m) => /qwen/i.test(m.id))
  if (anyQwen) return anyQwen
  const trained = models.find((m) => m.toolUseTrained)
  if (trained) return trained
  return models[0] ?? null
}
