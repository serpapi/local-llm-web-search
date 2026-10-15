import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import {
  createJob,
  describeMissingAnswer,
  jobStore,
  jobView,
  queue,
  stopRuns,
} from "../bench-job.server"
import { writeFileAtomic } from "../bench-runs.server"
import type { StartJobInput } from "@/lib/bench-schemas"

describe("describeMissingAnswer", () => {
  it("says the model kept searching when its last reply was a tool call", () => {
    expect(
      describeMissingAnswer(
        "Let me verify.\n<tool_call>\n<function=google_news_search>\n<parameter=query>Apple CEO</parameter>\n</function>\n</tool_call>"
      )
    ).toMatch(/kept asking for another search/)
  })

  it("recognises Gemma 4's inline tool call too", () => {
    expect(
      describeMissingAnswer(
        '<|tool_call>call:google_search{query:<|"|>Apple CEO<|"|>}<tool_call|>'
      )
    ).toMatch(/kept asking for another search/)
  })

  it("says when the reasoning used the whole token budget", () => {
    expect(describeMissingAnswer("", true)).toMatch(/whole 4,096-token budget/)
  })

  it("separates an unusable reply from an empty one", () => {
    expect(describeMissingAnswer("<think>hmm</think>")).toMatch(/no usable/)
    expect(describeMissingAnswer("")).toMatch(/empty reply/)
    expect(describeMissingAnswer(null)).toMatch(/empty reply/)
  })
})

const model = {
  id: "qwen/qwen3.8-27b",
  params: "27B",
  arch: "qwen3",
  format: "mlx" as const,
  requestedContext: 32768,
  toolUseTrained: true,
}

const e2eInput: StartJobInput = {
  tier: "e2e",
  name: "nightly",
  model,
  modes: ["json", "markdown"],
  questions: [
    { label: "Search", question: "Who is the CEO of Apple?" },
    { label: "Maps", question: "Barbecue in Austin?" },
  ],
  keepPayload: [],
}

describe("createJob", () => {
  it("names the file after the start time and keeps the run's selections", () => {
    const job = createJob(e2eInput, new Date("2026-10-05T15:24:57.123Z"))
    expect(job.file).toBe("2026-10-05T15-24-57-nightly.json")
    expect(job.status).toBe("running")
    expect(job.total).toBe(4)
    expect(job.modes).toEqual(["json", "markdown"])
    expect(job.labels).toEqual(["Search", "Maps"])
    expect(job.run.model?.id).toBe(model.id)
  })

  it("keeps the page's selections on a payload run", () => {
    const job = createJob(
      {
        tier: "payload",
        name: "",
        model: null,
        calls: [{ label: "Search", name: "google_search", args: {} }],
        keepE2E: [],
        modes: ["markdown"],
        labels: ["News"],
      },
      new Date("2026-10-05T15:24:57.123Z")
    )
    expect(job.name).toBe("run")
    expect(job.modes).toEqual(["markdown"])
    expect(job.labels).toEqual(["News"])
  })
})

describe("stopRuns", () => {
  afterEach(() => {
    queue().length = 0
    clearInterval(jobStore.__benchQueueTimer)
    jobStore.__benchQueueTimer = undefined
    jobStore.__benchJob = null
    jobStore.__benchStop = false
  })

  it("stops the run in progress and drops the queue", () => {
    jobStore.__benchJob = createJob(e2eInput, new Date())
    queue().push(e2eInput, e2eInput)
    jobStore.__benchQueueTimer = setInterval(() => {}, 60_000)

    const job = stopRuns()

    expect(job?.status).toBe("stopping")
    expect(jobStore.__benchStop).toBe(true)
    expect(queue()).toHaveLength(0)
    expect(jobStore.__benchQueueTimer).toBeUndefined()
  })

  it("drops the queue when Stop lands between two queued runs", () => {
    const done = createJob(e2eInput, new Date())
    done.status = "done"
    jobStore.__benchJob = done
    queue().push(e2eInput)

    const job = stopRuns()

    expect(job?.status).toBe("done")
    expect(jobStore.__benchStop).toBe(false)
    expect(queue()).toHaveLength(0)
  })
})

describe("jobView", () => {
  afterEach(() => {
    queue().length = 0
    jobStore.__benchJob = null
  })

  it("lists the models queued after the run on screen", () => {
    jobStore.__benchJob = createJob(e2eInput, new Date())
    const gemma = {
      ...e2eInput,
      model: { ...e2eInput.model, id: "google/gemma-4-12b-qat" },
    } as StartJobInput
    queue().push(gemma)
    expect(jobView()?.next).toEqual(["google/gemma-4-12b-qat"])
  })

  it("is null before any run", () => {
    expect(jobView()).toBeNull()
  })
})

describe("writeFileAtomic", () => {
  it("replaces the file in one step and leaves no temp file behind", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bench-"))
    try {
      const path = join(dir, "run.json")
      await writeFile(path, "old", "utf-8")
      await writeFileAtomic(path, "new")
      expect(await readFile(path, "utf-8")).toBe("new")
      expect(await readdir(dir)).toEqual(["run.json"])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
