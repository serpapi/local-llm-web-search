// What the JSON Restrictor kept: compares a full SerpApi response with the
// restricted one the model received, so the inspect dialog can highlight
// the kept parts of the full response. Browser-safe.

import { parseMarkdown } from "@tanstack/markdown/parser"
import type {
  BlockNode,
  InlineNode,
  MarkdownDocument,
} from "@tanstack/markdown"

import type { JsonValue } from "@/lib/agent-types"

type JsonLine = { text: string; kept: boolean }

function isObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * `full` pretty-printed exactly like `JSON.stringify(full, null, 2)`, one
 * entry per line, with `kept` set on the lines whose node is also in
 * `sent`. The restrictor keeps whole keys and the first N array items, so
 * walking both trees together marks exactly what survived.
 */
export function keptJsonLines(
  full: JsonValue,
  sent: JsonValue
): Array<JsonLine> {
  const lines: Array<JsonLine> = []
  const print = (
    value: JsonValue,
    kept: JsonValue | undefined,
    indent: string,
    prefix: string,
    suffix: string
  ) => {
    const isKept = kept !== undefined
    if (Array.isArray(value) && value.length > 0) {
      lines.push({ text: `${indent}${prefix}[`, kept: isKept })
      value.forEach((item, i) =>
        print(
          item,
          Array.isArray(kept) ? kept[i] : undefined,
          `${indent}  `,
          "",
          i < value.length - 1 ? "," : ""
        )
      )
      lines.push({ text: `${indent}]${suffix}`, kept: isKept })
    } else if (isObject(value) && Object.keys(value).length > 0) {
      const entries = Object.entries(value)
      lines.push({ text: `${indent}${prefix}{`, kept: isKept })
      entries.forEach(([key, child], i) =>
        print(
          child,
          isObject(kept) && Object.hasOwn(kept, key) ? kept[key] : undefined,
          `${indent}  `,
          `${JSON.stringify(key)}: `,
          i < entries.length - 1 ? "," : ""
        )
      )
      lines.push({ text: `${indent}}${suffix}`, kept: isKept })
    } else {
      lines.push({
        text: `${indent}${prefix}${JSON.stringify(value)}${suffix}`,
        kept: isKept,
      })
    }
  }
  print(full, sent, "", "", "")
  // The outer braces hold everything, so marking them says nothing.
  if (lines.length > 1) {
    lines[0].kept = false
    lines[lines.length - 1].kept = false
  }
  return lines
}

function inlineText(nodes: Array<InlineNode>): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "inlineCode":
        case "inlineHtml":
          return node.value
        case "image":
          return node.alt
        case "break":
          return " "
        case "footnoteReference":
          return ""
        default:
          return inlineText(node.children)
      }
    })
    .join("")
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim()

type Inlines = { children: Array<InlineNode> }

// One comparable piece of a Markdown document, with the places to mark
// when it was kept (`TCell`: AST nodes for the preview, character ranges for
// the source). Text pieces compare by `key`; a table row compares by the
// values under each column header, so a row whose restricted version
// dropped columns still matches.
type Unit<TCell> =
  | { kind: "text"; key: string; cell: TCell }
  | { kind: "header"; headers: Array<string>; cells: Array<TCell> }
  | { kind: "row"; values: Map<string, string>; cells: Map<string, TCell> }

// Units grouped by section. SerpApi writes each top-level key as a `##`
// heading and orders the restricted sections as the restrictor lists them,
// so a section is matched by name (numbered when a name repeats), never by
// position.
type Sections<TCell> = Map<string, Array<Unit<TCell>>>

function sectionBuilder<TCell>() {
  const out: Sections<TCell> = new Map()
  const names = new Map<string, number>()
  let current: Array<Unit<TCell>> = []
  out.set("", current)
  return {
    out,
    start(name: string) {
      const n = (names.get(name) ?? 0) + 1
      names.set(name, n)
      current = []
      out.set(`${name}#${n}`, current)
    },
    push(unit: Unit<TCell>) {
      current.push(unit)
    },
  }
}

function rowUnit<TCell>(
  headers: Array<string>,
  cells: Array<{ text: string; cell: TCell }>
): Unit<TCell> {
  const values = new Map<string, string>()
  const byHeader = new Map<string, TCell>()
  cells.forEach(({ text, cell }, i) => {
    const header = headers[i] ?? ""
    if (values.has(header)) return
    values.set(header, text)
    byHeader.set(header, cell)
  })
  return { kind: "row", values, cells: byHeader }
}

/** The parsed document as headings, paragraphs and table rows. */
function astSections(doc: MarkdownDocument): Sections<Inlines> {
  const sections = sectionBuilder<Inlines>()
  const visit = (blocks: Array<BlockNode>, depth: number) => {
    for (const block of blocks) {
      switch (block.type) {
        case "heading":
        case "paragraph": {
          const text = normalize(inlineText(block.children))
          if (block.type === "heading" && block.depth <= 2) sections.start(text)
          const kind =
            block.type === "heading" ? `h${block.depth}` : `p${depth}`
          if (text) {
            sections.push({ kind: "text", key: `${kind}:${text}`, cell: block })
          }
          break
        }
        case "list":
          for (const item of block.items) visit(item.children, depth + 1)
          break
        case "table": {
          const headers = block.header.map((c) =>
            normalize(inlineText(c.children))
          )
          sections.push({ kind: "header", headers, cells: block.header })
          for (const row of block.rows) {
            sections.push(
              rowUnit(
                headers,
                row.map((cell) => ({
                  text: normalize(inlineText(cell.children)),
                  cell,
                }))
              )
            )
          }
          break
        }
        case "blockquote":
          visit(block.children, depth)
          break
        default:
          break
      }
    }
  }
  visit(doc.children, 0)
  return sections.out
}

type Range = [start: number, end: number]

// The cells of a Markdown table line, split on pipes that aren't escaped,
// each with its trimmed text and its range in the document. Outer pipes
// are optional in Markdown.
function tableCells(
  line: string,
  offset: number
): Array<{ text: string; cell: Range }> {
  const cells: Array<{ text: string; cell: Range }> = []
  const body = line.trimEnd()
  let start = body.trimStart().startsWith("|") ? body.indexOf("|") + 1 : 0
  for (let k = start; k <= body.length; k++) {
    if (k < body.length && (body[k] !== "|" || body[k - 1] === "\\")) continue
    const raw = body.slice(start, k)
    const lead = raw.length - raw.trimStart().length
    const text = raw.trim()
    if (k < body.length || text !== "") {
      const from = offset + start + lead
      cells.push({ text, cell: [from, from + text.length] })
    }
    start = k + 1
  }
  return cells
}

const HAS_PIPE = /(^|[^\\])\|/
const TABLE_SEPARATOR = /^\s*\|?(\s*:?-{3,}:?\s*\|)*\s*:?-{3,}:?\s*\|?\s*$/
// A table's separator row. It has a pipe, so a `---` rule doesn't count.
const isSeparator = (line: string) =>
  HAS_PIPE.test(line) && TABLE_SEPARATOR.test(line)
const LIST_ITEM = /^([-*+]|\d+[.)])\s+(.*)$/

/** The Markdown source as headings, lines and table rows, with ranges. */
function sourceSections(source: string): Sections<Range> {
  const sections = sectionBuilder<Range>()
  const lines = source.split("\n")
  let offset = 0
  let headers: Array<string> | null = null
  lines.forEach((line, n) => {
    const at = offset
    offset += line.length + 1
    const text = line.trim()
    if (text === "") {
      headers = null
      return
    }
    if (
      headers === null &&
      HAS_PIPE.test(line) &&
      isSeparator(lines[n + 1] ?? "")
    ) {
      const cells = tableCells(line, at)
      headers = cells.map((c) => c.text)
      sections.push({
        kind: "header",
        headers,
        cells: cells.map((c) => c.cell),
      })
      return
    }
    if (headers !== null && isSeparator(line)) return
    // A list item ends the table even without a blank line before it.
    if (headers !== null && HAS_PIPE.test(line) && !LIST_ITEM.test(text)) {
      sections.push(rowUnit(headers, tableCells(line, at)))
      return
    }
    headers = null
    const heading = /^(#{1,6})\s+(.*)$/.exec(text)
    if (heading && heading[1].length <= 2) sections.start(normalize(heading[2]))
    const indent = line.length - line.trimStart().length
    const from = at + indent
    // WHY: the indent stays in the key, so a nested field never stands in
    //      for a top-level one with the same text. Both documents come
    //      from the same renderer, so equal depth means equal indent.
    const item = LIST_ITEM.exec(text)
    const key = heading
      ? `h${heading[1].length}:${normalize(heading[2])}`
      : item
        ? `${indent}:li:${item[2]}`
        : `${indent}:p:${text}`
    sections.push({ kind: "text", key, cell: [from, from + text.length] })
  })
  return sections.out
}

// Whether a unit of the full response is the restricted unit `sent`, with
// some fields or columns possibly dropped.
function same<TCell>(sent: Unit<TCell>, full: Unit<TCell>): boolean {
  if (sent.kind === "text") return full.kind === "text" && full.key === sent.key
  if (sent.kind === "header") {
    return (
      full.kind === "header" &&
      sent.headers.every((h) => full.headers.includes(h))
    )
  }
  if (full.kind !== "row") return false
  let compared = 0
  for (const [header, value] of sent.values) {
    if (value === "") continue
    if (full.values.get(header) !== value) return false
    compared++
  }
  return compared > 0
}

// Above this many comparisons a section stays unmarked rather than block
// the page: about 8 MB and a few hundred milliseconds at the limit.
const MAX_COMPARISONS = 2_000_000

/**
 * Pairs each restricted unit `a` with the full unit `b` it came from. The
 * restrictor only deletes: it drops fields, columns and array items and
 * keeps the rest in order. So the kept units are the longest common
 * subsequence of the two, the same alignment `diff` uses, which a deleted
 * list, table or item can't throw off. A restricted unit left over (a
 * field the restricted output lists in another order) is paired afterwards
 * when exactly one unmatched full unit equals it; an ambiguous one stays
 * unpaired.
 */
function align<TCell>(
  a: Array<Unit<TCell>>,
  b: Array<Unit<TCell>>
): Array<[Unit<TCell>, Unit<TCell>]> {
  // lcs[i * (b.length + 1) + j]: the longest match of a[i..] and b[j..].
  const width = b.length + 1
  const lcs = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = same(a[i], b[j])
        ? lcs[(i + 1) * width + j + 1] + 1
        : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1])
    }
  }
  // Walk forward, taking each match as early as possible, so a result
  // kept once marks its first occurrence.
  const matched = new Set<Unit<TCell>>()
  const pairs: Array<[Unit<TCell>, Unit<TCell>]> = []
  const leftover: Array<Unit<TCell>> = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (
      same(a[i], b[j]) &&
      lcs[i * width + j] === lcs[(i + 1) * width + j + 1] + 1
    ) {
      pairs.push([a[i], b[j]])
      matched.add(b[j])
      i++
      j++
    } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
      leftover.push(a[i])
      i++
    } else {
      j++
    }
  }
  leftover.push(...a.slice(i))
  for (const unit of leftover) {
    const candidates = b.filter((u) => !matched.has(u) && same(unit, u))
    if (candidates.length !== 1) continue
    pairs.push([unit, candidates[0]])
    matched.add(candidates[0])
  }
  return pairs
}

/**
 * The places in `full` that `sent` kept. Sections pair up by name, then
 * `align` pairs their contents; of a table, only the kept columns count.
 */
function keptCells<TCell>(
  full: Sections<TCell>,
  sent: Sections<TCell>
): Array<TCell> {
  const cells: Array<TCell> = []
  for (const [name, a] of sent) {
    const b = full.get(name)
    if (!b || a.length * b.length > MAX_COMPARISONS) continue
    for (const [kept, unit] of align(a, b)) {
      if (unit.kind === "text") cells.push(unit.cell)
      else if (unit.kind === "header" && kept.kind === "header") {
        unit.headers.forEach((h, k) => {
          if (kept.headers.includes(h)) cells.push(unit.cells[k])
        })
      } else if (unit.kind === "row" && kept.kind === "row") {
        for (const [header, value] of kept.values) {
          const cell = unit.cells.get(header)
          if (value !== "" && cell) cells.push(cell)
        }
      }
    }
  }
  return cells
}

/**
 * The full Markdown response parsed for TanStack Markdown, with the parts
 * the restricted response kept wrapped in `<mark className={className}>`.
 */
export function markKeptMarkdown(
  full: string,
  sent: string,
  className: string
): MarkdownDocument {
  const doc = parseMarkdown(full)
  for (const node of keptCells(
    astSections(doc),
    astSections(parseMarkdown(sent))
  )) {
    node.children = [
      {
        type: "inlineComponent",
        name: "kept",
        attributes: {},
        tagName: "mark",
        properties: { className, "data-kept": "true" },
        children: node.children,
      },
    ]
  }
  return doc
}

/**
 * The character ranges of the full Markdown source that the restricted
 * response kept, for highlighting the source as written.
 */
export function keptMarkdownRanges(full: string, sent: string): Array<Range> {
  return keptCells(sourceSections(full), sourceSections(sent)).filter(
    ([start, end]) => end > start
  )
}
