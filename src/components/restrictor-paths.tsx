import { Check } from "lucide-react"

import type { JsonValue } from "@/lib/agent-types"
import { cn } from "@/lib/utils"

// Split a restrictor string into its top-level paths, one per card. Commas
// inside `{…}` projections or `[…]` slices belong to a nested path, so we
// only break on commas at depth zero.
function splitTopLevelPaths(restrictor: string): Array<string> {
  const paths: Array<string> = []
  let depth = 0
  let current = ""
  for (const ch of restrictor) {
    if (ch === "{" || ch === "[") depth += 1
    else if (ch === "}" || ch === "]") depth -= 1
    if (ch === "," && depth === 0) {
      paths.push(current)
      current = ""
    } else {
      current += ch
    }
  }
  if (current) paths.push(current)
  return paths.map((p) => p.trim()).filter(Boolean)
}

// Split one path into the object/array it selects from and the fields it
// keeps. `organic_results[0:5].{title,link}` → head `organic_results[0:5]`,
// fields `[title, link]`. A path with no projection keeps the whole node.
function parseRestrictorPath(path: string): {
  head: string
  fields: Array<string>
} {
  const braceStart = path.indexOf(".{")
  if (braceStart === -1 || !path.endsWith("}")) {
    return { head: path, fields: [] }
  }
  const head = path.slice(0, braceStart)
  const inner = path.slice(braceStart + 2, -1)
  return { head, fields: splitTopLevelPaths(inner) }
}

// A field is itself a projection when it carries its own `.{…}`, e.g.
// `flights[].{airline,…}` keeps a node and selects from inside it. Those
// recurse into nested groups; everything else is a leaf chip.
function isProjection(path: string): boolean {
  return parseRestrictorPath(path).fields.length > 0
}

type PathStatus = "returned" | "absent" | "sources"

// Whether a top-level path came back in this response. SerpApi drops paths
// the engine didn't return, so most of a restrictor is usually absent.
// `search_metadata` is the SERP link the agent keeps for Sources and
// removes before the model reads the response.
//
// JSON: the top-level key is present. Markdown: SerpApi renders each
// top-level key as a heading (`related_questions` → `## Related Questions`).
function pathStatus(path: string, response: JsonValue): PathStatus {
  const key = path.split(/[.[]/)[0]
  if (key === "search_metadata") return "sources"
  if (typeof response === "string") {
    const words = key.split("_").map(escapeRegExp).join("[ _]")
    return new RegExp(`^#{1,4}\\s+${words}\\s*$`, "im").test(response)
      ? "returned"
      : "absent"
  }
  if (response && typeof response === "object" && !Array.isArray(response)) {
    return key in response ? "returned" : "absent"
  }
  return "absent"
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

const STATUS_ORDER: Record<PathStatus, number> = {
  returned: 0,
  absent: 1,
  sources: 2,
}

const STATUS_LABEL: Record<PathStatus, string> = {
  returned: "Returned",
  absent: "Not in this response",
  sources: "Sources only",
}

/**
 * A `json_restrictor` string as one card per top-level path, each showing
 * the fields it keeps. With `response`, each card also says whether that
 * path came back for this search, and absent paths are dimmed. The `grid`
 * layout lays the returned paths out in columns and lists the rest on one
 * line, for a full-width strip.
 */
export function RestrictorPaths({
  restrictor,
  response,
  layout = "column",
}: {
  restrictor: string
  // What the model received. Omit when it wasn't recorded (saved runs).
  response?: JsonValue
  layout?: "column" | "grid"
}) {
  // WHY: returned paths first, so what reached the model reads at a glance;
  //      the rest keep the restrictor's order below them.
  const rows = splitTopLevelPaths(restrictor).map((path) => ({
    path,
    status: response === undefined ? undefined : pathStatus(path, response),
  }))
  if (response !== undefined) {
    rows.sort((a, b) => STATUS_ORDER[a.status!] - STATUS_ORDER[b.status!])
  }
  const returned = rows.filter((r) => r.status === "returned").length
  const answerPaths = rows.filter((r) => r.status !== "sources").length
  const summary =
    response !== undefined ? (
      <p className="text-xs text-muted-foreground tabular-nums">
        {returned} of {answerPaths} paths returned
      </p>
    ) : null

  if (layout === "grid") {
    const others = rows.filter((r) => r.status !== "returned")
    return (
      <div className="flex flex-col gap-2">
        {summary}
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {rows
            .filter((r) => r.status === "returned")
            .map(({ path, status }, i) => (
              <div
                key={i}
                className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-background p-2.5"
              >
                <RestrictorNode path={path} status={status} />
              </div>
            ))}
        </div>
        {others.length > 0 ? (
          <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            {others.map(({ path, status }, i) => (
              <li key={i} className="flex items-baseline gap-1.5">
                <code className="font-mono text-[10px]">
                  {parseRestrictorPath(path).head}
                </code>
                <span>{status ? STATUS_LABEL[status] : null}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      {summary}
      {rows.map(({ path, status }, i) => {
        return (
          <div
            key={i}
            className={cn(
              "flex flex-col gap-1.5 rounded-lg border border-border/60 bg-muted/40 p-2.5",
              status && status !== "returned" && "opacity-55"
            )}
          >
            <RestrictorNode path={path} status={status} />
          </div>
        )
      })}
    </div>
  )
}

// Render one restrictor path as a node: its head as a mono label, then its
// fields below. Leaf fields collapse into a single wrapping row of chips;
// fields that are themselves projections (`flights[].{…}`) recurse into a
// nested node, indented under a guide line. This mirrors the shape of the
// kept data, so a deeply nested flights restrictor reads as a tree that
// wraps inside the column instead of one long chip that overflows it.
function RestrictorNode({
  path,
  depth = 0,
  status,
}: {
  path: string
  depth?: number
  status?: PathStatus
}) {
  const { head, fields } = parseRestrictorPath(path)
  // WHY: split leaves from nested projections so the short scalar fields
  //      stay packed together as chips and the nested ones each get room.
  const leaves = fields.filter((f) => !isProjection(f))
  const nested = fields.filter(isProjection)

  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-1.5",
        depth > 0 && "border-l border-border/60 pl-2.5"
      )}
    >
      <div className="flex items-baseline justify-between gap-2">
        <code className="font-mono text-[11px] font-medium break-all text-foreground/90">
          {head}
        </code>
        {status ? (
          <span
            className={cn(
              "flex shrink-0 items-center gap-1 text-[10px]",
              status === "returned"
                ? "font-medium text-foreground"
                : "text-muted-foreground"
            )}
          >
            {status === "returned" ? (
              <Check aria-hidden className="size-3" />
            ) : null}
            {STATUS_LABEL[status]}
          </span>
        ) : null}
      </div>
      {leaves.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {leaves.map((f, j) => (
            <span
              key={j}
              className="max-w-full rounded border border-border/60 bg-background px-1.5 py-0.5 font-mono text-[10px] break-all text-muted-foreground"
            >
              {f}
            </span>
          ))}
        </div>
      ) : null}
      {nested.map((f, j) => (
        <RestrictorNode key={j} path={f} depth={depth + 1} />
      ))}
    </div>
  )
}
