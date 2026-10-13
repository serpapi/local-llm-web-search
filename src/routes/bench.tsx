import { useEffect, useMemo, useRef, useState } from "react"
import { createFileRoute, notFound } from "@tanstack/react-router"
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query"

import type { ModelInfo, ToolOutput } from "@/lib/agent-types"
import type {
  BenchJob,
  BenchRun,
  E2ECell,
  SavedBenchRun,
  StartJobInput,
} from "@/server/bench"
import type { E2ETierState } from "@/components/bench/e2e-tier"
import type { PayloadTierState } from "@/components/bench/payload-tier"
import type { SaveState } from "@/components/bench/saved-runs"
import { TOOL_OUTPUTS } from "@/lib/agent-types"
import { listModels } from "@/server/models"
import {
  benchQueries,
  queueBenchJobs,
  saveBenchRun,
  startBenchJob,
  stopBenchJob,
} from "@/server/bench"
import { buildExamples } from "@/lib/examples"
import { pickDefaultModel } from "@/lib/models"
import { useTheme } from "@/hooks/use-theme"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { TooltipProvider } from "@/components/ui/tooltip"
import { PagePending } from "@/components/route-states"
import { BenchHeader } from "@/components/bench/bench-header"
import { E2ETier } from "@/components/bench/e2e-tier"
import { PayloadTier } from "@/components/bench/payload-tier"
import { SavedRuns } from "@/components/bench/saved-runs"
import { isActiveJob, payloadCalls, queuedRunName } from "@/lib/bench"

// ─── /bench: dev-only benchmark page ───────────────────
// Compares the three SerpApi output modes on the example questions without
// touching the chat UI. Two tiers:
//   • Payload: SerpApi only. One call per tool per mode; reports the size
//     of the tool result the model would read. Seconds, no LLM.
//   • End to end: runs each example through the agent loop in each selected
//     mode with the local model, one at a time, fresh history each time.
// Both tiers run as a job on the server (`startBenchJob`); the page polls
// it, so a reload or code edit never loses or orphans a run. Runs save to
// bench/results/<timestamp>-<name>.json after every cell.

export const Route = createFileRoute("/bench")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound()
  },
  // WHY: all three loads are route data. LM Studio being offline is a
  //      normal state the header explains inline, so it comes back as data.
  //      The job is read fresh on every visit: a run may have started, kept
  //      going, or been lost while the page was away.
  loader: async ({ context }): Promise<BenchLoaderData> => {
    const [modelsResult] = await Promise.all([
      listModels()
        .then((models) => ({ models, error: null as string | null }))
        .catch((err: unknown) => ({
          models: [] as Array<ModelInfo>,
          error: err instanceof Error ? err.message : String(err),
        })),
      context.queryClient.query(benchQueries.saved()),
      context.queryClient.query({ ...benchQueries.job(), staleTime: 0 }),
    ])
    return modelsResult
  },
  head: () => ({
    meta: [{ title: "Output benchmark · SerpApi Local Agent Lab" }],
  }),
  pendingComponent: PagePending,
  component: BenchPage,
})

type BenchLoaderData = {
  models: Array<ModelInfo>
  error: string | null
}

const POLL_MS = 1500

/** A run is active, or queued runs are waiting for the next one. */
function isBusy(job: BenchJob | null | undefined): boolean {
  return isActiveJob(job) || (job != null && job.next.length > 0)
}

// Used when the run-name field is left empty.
const DEFAULT_RUN_NAME = "run"

function findModel(
  models: Array<ModelInfo>,
  id: string | undefined
): ModelInfo | undefined {
  return id === undefined ? undefined : models.find((m) => m.id === id)
}

function findModels(
  models: Array<ModelInfo>,
  ids: Array<string>
): Array<ModelInfo> {
  return ids.flatMap((id) => findModel(models, id) ?? [])
}

function BenchPage() {
  const { models, error: modelsError } = Route.useLoaderData()
  const queryClient = useQueryClient()
  // The server-side job is the source of truth for a run in progress. It is
  // polled while a run is active or queued: between two queued runs nothing
  // runs for a few seconds, but the page stays locked until the queue is
  // empty.
  const { data: job } = useSuspenseQuery({
    ...benchQueries.job(),
    refetchInterval: (query) => (isBusy(query.state.data) ? POLL_MS : false),
  })
  const { data: saved } = useSuspenseQuery(benchQueries.saved())
  const setJob = (next: BenchJob | null) =>
    queryClient.setQueryData(benchQueries.job().queryKey, next)
  const { theme, toggleTheme } = useTheme()

  const groups = useMemo(() => buildExamples(), [])
  const examples = useMemo(
    () => groups.flatMap((g) => g.items.map((i) => ({ ...i, group: g.title }))),
    [groups]
  )
  const calls = useMemo(() => payloadCalls(), [])

  // Default to the live-data questions: the no-tool ones can't tell the
  // output modes apart, since no SerpApi result is ever sent.
  const defaultSelection = () =>
    new Set(examples.filter((e) => e.group === "Live data").map((e) => e.label))

  // A run still going when the page loaded. Its model, modes and questions
  // seed the page, so a reload shows what is running instead of defaults.
  const loadedRun = isActiveJob(job) ? job : null

  // The models picked, in run order. Several run one after another.
  const [chosen, setChosen] = useState<Array<ModelInfo>>(() => {
    const first =
      findModel(models, loadedRun?.run.model?.id) ?? pickDefaultModel(models)
    if (!first) return []
    return [first, ...findModels(models, job?.next ?? [])]
  })
  const model = chosen.at(0) ?? null
  const [modes, setModes] = useState<Array<ToolOutput>>(() =>
    loadedRun && loadedRun.modes.length > 0
      ? loadedRun.modes
      : [...TOOL_OUTPUTS]
  )
  const [selected, setSelected] = useState<ReadonlySet<string>>(() =>
    loadedRun && loadedRun.labels.length > 0
      ? new Set(loadedRun.labels)
      : defaultSelection()
  )

  // The tables show the job's run while it is active, and a saved run
  // otherwise.
  const [jobError, setJobError] = useState<string | null>(null)
  // The dev server restarted mid-run and no longer knows about it.
  const [lostRun, setLostRun] = useState(false)
  const [payload, setPayload] = useState<BenchRun["payload"]>(
    loadedRun?.run.payload ?? []
  )
  const [cells, setCells] = useState<Array<E2ECell>>(loadedRun?.run.e2e ?? [])

  const [runName, setRunName] = useState(loadedRun?.name ?? "")
  // The file the tables live in and the name they were saved under. Runs
  // write their file as they go, so any run on screen is already on disk.
  const [onDisk, setOnDisk] = useState<{ file: string; name: string } | null>(
    loadedRun ? { file: loadedRun.file, name: loadedRun.name } : null
  )
  // The model the run on screen used. Save records it, not the picker's.
  const [runModel, setRunModel] = useState<BenchRun["model"]>(
    loadedRun?.run.model ?? null
  )

  const running = isActiveJob(job)
  const busy = isBusy(job)

  // Put a server job's run on screen: tables, name, file, model, modes and
  // questions. Only calls setters, so it can run during render.
  function showJob(next: BenchJob) {
    setLostRun(false)
    setPayload(next.run.payload)
    setCells(next.run.e2e)
    setRunName(next.name)
    setOnDisk({ file: next.file, name: next.name })
    setRunModel(next.run.model)
    if (next.modes.length > 0) setModes(next.modes)
    if (next.labels.length > 0) setSelected(new Set(next.labels))
  }

  // WHY: adopt each new copy of the job, from a poll, a mutation or a
  //      fresh visit, while rendering. A run that started, kept going or was
  //      lost while the page was away shows the same as one watched here.
  const [shownJob, setShownJob] = useState(job)
  if (shownJob !== job) {
    setShownJob(job)
    const wasRunning = isActiveJob(shownJob)
    if (job === null) {
      // No job at all means the dev server restarted and forgot the run.
      if (wasRunning) setLostRun(true)
    } else if (isActiveJob(job) || (wasRunning && job.id === shownJob.id)) {
      if (job.id !== shownJob?.id) {
        const picked = findModels(models, [
          job.run.model?.id ?? "",
          ...job.next,
        ])
        if (picked.length > 0) setChosen(picked)
      }
      showJob(job)
    }
  }

  // The last run of a batch wrote its file, so the saved list is stale.
  const wasBusy = useRef(busy)
  useEffect(() => {
    if (wasBusy.current && !busy) {
      void queryClient.invalidateQueries({
        queryKey: benchQueries.saved().queryKey,
      })
    }
    wasBusy.current = busy
  }, [busy])

  // Save writes a new timestamped copy, so it only makes sense once the
  // name differs from the file the run is already in.
  const hasData = payload.length > 0 || cells.length > 0
  const canSave =
    hasData &&
    (onDisk === null || onDisk.name !== (runName || DEFAULT_RUN_NAME))

  const saveRun = useMutation({
    mutationFn: (name: string) =>
      saveBenchRun({
        data: {
          name,
          run: {
            version: 2,
            savedAt: new Date().toISOString(),
            name,
            model: runModel,
            payload,
            e2e: cells,
          },
        },
      }),
    onSuccess: ({ file }, name) => {
      setOnDisk({ file, name })
      return queryClient.invalidateQueries({
        queryKey: benchQueries.saved().queryKey,
      })
    },
  })
  // Errors land in `saveState` instead of the console.
  const saveState: SaveState = saveRun.isPending
    ? { status: "saving" }
    : saveRun.isSuccess
      ? { status: "saved", file: saveRun.data.file }
      : saveRun.isError
        ? { status: "error", message: saveRun.error.message }
        : { status: "idle" }

  function modelMeta(m: ModelInfo) {
    return {
      id: m.id,
      params: m.params,
      arch: m.arch,
      format: m.format,
      requestedContext: m.recommendedContextLength,
      toolUseTrained: m.toolUseTrained,
    }
  }

  // The job each of these returns goes into the cache, and the page adopts
  // it like a poll.
  const onJobError = (err: Error) => setJobError(err.message)
  const startRun = useMutation({
    mutationFn: (input: StartJobInput) => startBenchJob({ data: input }),
    onMutate: () => setJobError(null),
    onSuccess: setJob,
    onError: onJobError,
  })
  const queueBatch = useMutation({
    mutationFn: (runs: Array<StartJobInput>) => queueBenchJobs({ data: runs }),
    onMutate: () => setJobError(null),
    onSuccess: (next) => {
      if (next) setJob(next)
    },
    onError: onJobError,
  })
  const stopRun = useMutation({
    mutationFn: () => stopBenchJob(),
    onSuccess: setJob,
    onError: onJobError,
  })

  function runPayloadTier() {
    startRun.mutate({
      tier: "payload",
      name: runName,
      model: model ? modelMeta(model) : null,
      calls,
      keepE2E: cells,
      modes,
      labels: [...selected],
    })
  }

  function runE2ETier() {
    const questions = examples
      .filter((ex) => selected.has(ex.label))
      .map((ex) => ({ label: ex.label, question: ex.question }))
    if (chosen.length > 1) {
      queueBatch.mutate(
        chosen.map((m) => ({
          tier: "e2e" as const,
          name: queuedRunName(runName, m.id),
          model: modelMeta(m),
          modes,
          questions,
          keepPayload: payload,
        }))
      )
      return
    }
    if (!model) return
    startRun.mutate({
      tier: "e2e",
      name: runName,
      model: modelMeta(model),
      modes,
      questions,
      keepPayload: payload,
    })
  }

  const payloadState: PayloadTierState =
    job?.tier === "payload" && running
      ? { status: "running", current: job.current }
      : job?.tier === "payload" && job.status === "error"
        ? { status: "error", message: job.error ?? "The run failed." }
        : { status: "idle" }

  const e2eState: E2ETierState =
    job?.tier === "e2e" && busy
      ? {
          status: job.status === "stopping" ? "stopping" : "running",
          current: running ? job.current : null,
          // Between queued runs, the next run is about to start at cell 1.
          done: running ? job.done : 0,
          total: job.total,
        }
      : job?.tier === "e2e" && job.status === "error"
        ? { status: "error", message: job.error ?? "The run failed." }
        : { status: "idle" }

  // Close the opened run: empty tables, default selections, default name.
  function newRun() {
    setPayload([])
    setCells([])
    setOnDisk(null)
    setRunModel(null)
    setRunName("")
    saveRun.reset()
    setJobError(null)
    setLostRun(false)
    setModes([...TOOL_OUTPUTS])
    setSelected(defaultSelection())
  }

  function openRun({ file, run }: SavedBenchRun) {
    setPayload(run.payload)
    setCells(run.e2e)
    setOnDisk({ file, name: run.name })
    setRunModel(run.model)
    setRunName(run.name)
    saveRun.reset()
    setLostRun(false)
    // WHY: restore the columns and rows the run actually covered so the
    //      table shows what was measured, not today's selector state.
    const runModes = TOOL_OUTPUTS.filter((m) =>
      run.e2e.some((c) => c.output === m)
    )
    if (runModes.length > 0) setModes(runModes)
    const runLabels = new Set(run.e2e.map((c) => c.label))
    if (runLabels.size > 0) setSelected(runLabels)
    const match = findModel(models, run.model?.id)
    if (match) setChosen([match])
  }

  const untrained = chosen.find((m) => !m.toolUseTrained)
  const runDisabledReason =
    modelsError !== null
      ? "LM Studio is unreachable."
      : model === null
        ? "Pick a model first."
        : untrained
          ? `${untrained.id} isn't flagged for tool use.`
          : null

  return (
    <TooltipProvider delayDuration={200}>
      <div className="min-h-svh bg-muted/40">
        <div className="sticky top-0 z-30 border-b border-border/60 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
          <div className="mx-auto w-full max-w-6xl px-6 py-3">
            <BenchHeader
              models={models}
              selectedModels={chosen}
              onSelectModels={(ids) => setChosen(findModels(models, ids))}
              modelsError={modelsError}
              theme={theme}
              onToggleTheme={toggleTheme}
              runName={runName}
              onRunNameChange={setRunName}
              runNameLocked={busy}
            />
          </div>
        </div>
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
          {lostRun ? (
            <Alert>
              <AlertTitle>The dev server restarted during the run</AlertTitle>
              <AlertDescription>
                Finished cells were saved to bench/results.
              </AlertDescription>
            </Alert>
          ) : null}
          {jobError !== null ? (
            <Alert variant="destructive">
              <AlertTitle>Couldn't start the run</AlertTitle>
              <AlertDescription>{jobError}</AlertDescription>
            </Alert>
          ) : null}
          {payloadState.status === "error" ? (
            <Alert variant="destructive">
              <AlertTitle>The payload tier stopped</AlertTitle>
              <AlertDescription>{payloadState.message}</AlertDescription>
            </Alert>
          ) : null}
          {e2eState.status === "error" ? (
            <Alert variant="destructive">
              <AlertTitle>The end-to-end tier stopped</AlertTitle>
              <AlertDescription>{e2eState.message}</AlertDescription>
            </Alert>
          ) : null}

          <PayloadTier
            calls={calls}
            rows={payload}
            state={payloadState}
            onRun={runPayloadTier}
          />

          <E2ETier
            groups={groups}
            examples={examples}
            selected={selected}
            onSetExamples={(labels, checked) =>
              setSelected((cur) => {
                const next = new Set(cur)
                for (const label of labels) {
                  if (checked) next.add(label)
                  else next.delete(label)
                }
                return next
              })
            }
            modes={modes}
            onChangeModes={setModes}
            cells={cells}
            payload={payload}
            state={e2eState}
            canRun={runDisabledReason === null}
            runDisabledReason={runDisabledReason}
            modelCount={chosen.length}
            queuedModels={job?.next ?? []}
            onRun={runE2ETier}
            onStop={() => stopRun.mutate()}
          />

          <SavedRuns
            runs={saved.runs}
            unreadable={saved.unreadable}
            activeFile={onDisk?.file ?? null}
            onSave={() => saveRun.mutate(runName || DEFAULT_RUN_NAME)}
            canSave={canSave}
            saveState={saveState}
            onOpen={openRun}
            onNewRun={newRun}
            canStartNew={onDisk !== null || hasData}
            busy={busy}
          />
        </div>
      </div>
    </TooltipProvider>
  )
}
