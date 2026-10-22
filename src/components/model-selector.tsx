import { useState } from "react"
import { AlertTriangle, Check, Cpu } from "lucide-react"

import type { ModelInfo } from "@/lib/agent-types"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"

type ModelSelectorProps = {
  availableModels: Array<ModelInfo>
  modelsError: string | null
  // Which way the list opens. The chat composer sits at the bottom of the
  // page, so it opens upward like the Examples popover.
  side?: "top" | "bottom"
} & (
  | {
      multiple?: false
      selectedModel: ModelInfo | null
      onSelectModel: (id: string) => void
    }
  | {
      // /bench: pick several models to run one after another, in the order
      // they were picked.
      multiple: true
      selectedModels: Array<ModelInfo>
      onSelectModels: (ids: Array<string>) => void
    }
)

// The list splits models by whether they can call SerpApi at all.
const MODEL_GROUPS = [
  { title: "Tool use", toolUseTrained: true },
  { title: "No tool use", toolUseTrained: false },
]

/**
 * Picks the LM Studio model. Laid out like the Examples popover: the same
 * outline trigger, a title, and the models grouped by tool use, each with
 * its size as a badge.
 */
export function ModelSelector(props: ModelSelectorProps) {
  const { availableModels, modelsError, side = "bottom" } = props
  const [open, setOpen] = useState(false)
  if (modelsError !== null) {
    // WHY: a disabled Button takes no pointer events, so the wrapper holds
    //      the error text for hover. The composer's placeholder says what
    //      to do next.
    return (
      <span title={modelsError} className="inline-flex">
        <Button variant="outline" size="lg" disabled role="alert">
          <AlertTriangle data-icon="inline-start" />
          LM Studio unreachable
          <span className="sr-only">: {modelsError}</span>
        </Button>
      </span>
    )
  }

  if (availableModels.length === 0) {
    return (
      <Button variant="outline" size="lg" disabled>
        <AlertTriangle data-icon="inline-start" />
        No models loaded
      </Button>
    )
  }

  const picked = props.multiple
    ? props.selectedModels
    : props.selectedModel
      ? [props.selectedModel]
      : []
  const ids = picked.map((m) => m.id)

  function pick(id: string) {
    if (!props.multiple) {
      props.onSelectModel(id)
      setOpen(false)
      return
    }
    // Stays open, so several models can be ticked in a row. A run needs a
    // model, so the last one stays picked.
    if (!ids.includes(id)) props.onSelectModels([...ids, id])
    else if (ids.length > 1) props.onSelectModels(ids.filter((i) => i !== id))
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="lg"
          aria-label={props.multiple ? "Select models" : "Select model"}
        >
          <Cpu data-icon="inline-start" />
          <span className="max-w-56 truncate">
            {picked[0]?.id ?? "Pick a model"}
          </span>
          {picked.length > 1 ? (
            <span className="font-mono text-muted-foreground tabular-nums">
              +{picked.length - 1}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side={side}
        sideOffset={8}
        className="max-h-(--radix-popover-content-available-height) w-[340px] overflow-y-auto p-3"
      >
        <div className="flex flex-col gap-3">
          <span className="px-1 text-sm font-semibold">
            {props.multiple ? "Models" : "Model"}
          </span>
          {MODEL_GROUPS.map((group) => {
            const models = availableModels.filter(
              (m) => m.toolUseTrained === group.toolUseTrained
            )
            if (models.length === 0) return null
            return (
              <div key={group.title} className="flex flex-col gap-1.5">
                <div className="flex items-baseline justify-between px-1">
                  <span className="text-[11px] font-semibold tracking-wide uppercase">
                    {group.title}
                  </span>
                </div>
                <ul aria-label={group.title} className="flex flex-col gap-1">
                  {models.map((m) => {
                    const selected = ids.includes(m.id)
                    return (
                      <li key={m.id}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          aria-pressed={selected}
                          onClick={() => pick(m.id)}
                          className="w-full justify-start gap-2 text-left"
                        >
                          <Badge
                            variant="outline"
                            className="shrink-0 font-mono text-[10px]"
                          >
                            {m.params ?? "–"}
                          </Badge>
                          <span className="flex-1 truncate text-foreground">
                            {m.id}
                          </span>
                          {selected ? (
                            <Check
                              data-icon="inline-end"
                              className="text-serpapi-blue"
                            />
                          ) : null}
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
