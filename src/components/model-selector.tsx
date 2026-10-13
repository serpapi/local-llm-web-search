import { AlertTriangle, CheckCircle2, ChevronDown, Cpu } from "lucide-react"

import type { ModelInfo } from "@/lib/agent-types"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

type ModelSelectorProps = {
  availableModels: Array<ModelInfo>
  modelsError: string | null
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

/**
 * Picks the LM Studio model. The trigger is the same outline Button the
 * Examples popover uses, so the two read as one row of controls; the list
 * is a radio menu (or a checkbox menu with `multiple`) with the model's
 * size and architecture as a muted suffix.
 */
export function ModelSelector(props: ModelSelectorProps) {
  const { availableModels, modelsError } = props
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
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
          <ChevronDown
            data-icon="inline-end"
            className="text-muted-foreground"
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-max max-w-[min(32rem,90vw)]"
      >
        {props.multiple ? (
          availableModels.map((m) => (
            <DropdownMenuCheckboxItem
              key={m.id}
              checked={ids.includes(m.id)}
              // Stay open, so several models can be ticked in a row.
              onSelect={(e) => e.preventDefault()}
              onCheckedChange={(checked) => {
                if (checked) props.onSelectModels([...ids, m.id])
                // A run needs a model, so the last one stays picked.
                else if (ids.length > 1)
                  props.onSelectModels(ids.filter((id) => id !== m.id))
              }}
            >
              <ModelRow model={m} />
            </DropdownMenuCheckboxItem>
          ))
        ) : (
          <DropdownMenuRadioGroup
            value={props.selectedModel?.id}
            onValueChange={props.onSelectModel}
          >
            {availableModels.map((m) => (
              <DropdownMenuRadioItem key={m.id} value={m.id}>
                <ModelRow model={m} />
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ModelRow({ model }: { model: ModelInfo }) {
  const meta: Array<string> = []
  if (model.params) meta.push(model.params)
  if (model.arch) meta.push(model.arch)
  return (
    <>
      <span>{model.id}</span>
      {meta.length > 0 ? (
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {meta.join(" · ")}
        </span>
      ) : null}
      {model.toolUseTrained ? (
        <CheckCircle2
          aria-label="Trained for tool use"
          className="text-emerald-600 dark:text-emerald-400"
        />
      ) : (
        <AlertTriangle
          aria-label="Not flagged for tool use"
          className="text-amber-600 dark:text-amber-400"
        />
      )}
    </>
  )
}
