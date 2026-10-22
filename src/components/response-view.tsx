import { createContext, useContext, useEffect, useMemo, useRef } from "react"
import { createHighlighter } from "@tanstack/highlight/core"
import { json } from "@tanstack/highlight/languages/json"
import { markdown } from "@tanstack/highlight/languages/markdown"
import { createThemeCss } from "@tanstack/highlight/theme"
import { githubDarkTheme } from "@tanstack/highlight/themes/github-dark"
import { githubLightTheme } from "@tanstack/highlight/themes/github-light"
import { Markdown } from "@tanstack/markdown/react"
import { parseMarkdown } from "@tanstack/markdown/parser"
import type { ComponentProps } from "react"

import type { JsonValue } from "@/lib/agent-types"
import {
  keptJsonLines,
  keptMarkdownRanges,
  markKeptMarkdown,
} from "@/lib/restrictor-diff"

const highlighter = createHighlighter({ languages: [json, markdown] })

// WHY: in Tailwind's components layer, so utility classes on the pane
//      (its background) override the theme's.
const THEME_CSS = `@layer components {
${createThemeCss({ light: githubLightTheme, dark: githubDarkTheme, darkSelector: ".dark" })}
}`

/** How the parts the restrictor kept are marked, here and in the legend. */
export const KEPT_CLASS =
  "rounded-sm bg-yellow-200 text-inherit dark:bg-yellow-400/30"

// Wide tables (flights, hotels) scroll inside the pane, as in the chat.
function ScrollTable(props: ComponentProps<"table">) {
  return (
    <div className="typeset-scroll">
      <table {...props} />
    </div>
  )
}

// True inside a link, where an image must not become a second link.
const InsideLink = createContext(false)

function ExternalLink(props: ComponentProps<"a">) {
  return (
    <InsideLink.Provider value={true}>
      <a {...props} target="_blank" rel="noreferrer noopener" />
    </InsideLink.Provider>
  )
}

// WHY: a SerpApi page links images from sites nobody vetted, so they show
//      as links the reader can open instead of loading on render, as in
//      the chat's Markdown.
function ImageLink({ src, alt }: ComponentProps<"img">) {
  const insideLink = useContext(InsideLink)
  const url = typeof src === "string" ? src : ""
  const label = alt || url
  if (insideLink || !url) return <>{label}</>
  return (
    <a href={url} target="_blank" rel="noreferrer noopener">
      {label}
    </a>
  )
}

const MARKDOWN_COMPONENTS = {
  table: ScrollTable,
  a: ExternalLink,
  img: ImageLink,
}

/** How a Markdown response shows: as written, or rendered. */
export type MarkdownView = "source" | "preview"

const KEPT_DECORATION = { className: KEPT_CLASS, data: { kept: true } }

/**
 * A SerpApi response as the model reads it, highlighted with TanStack
 * Highlight. Markdown output shows as written, or rendered with TanStack
 * Markdown when `view` is "preview". With `keptIn`, the parts of `value`
 * that are also in that restricted response are marked with `KEPT_CLASS`.
 */
export function ResponseView({
  value,
  keptIn,
  view = "source",
}: {
  value: JsonValue
  keptIn?: JsonValue
  view?: MarkdownView
}) {
  const content = useMemo(() => {
    if (typeof value === "string" && view === "preview") {
      return {
        kind: "preview" as const,
        doc:
          typeof keptIn === "string"
            ? markKeptMarkdown(value, keptIn, KEPT_CLASS)
            : parseMarkdown(value),
      }
    }
    if (typeof value === "string") {
      const ranges =
        typeof keptIn === "string" ? keptMarkdownRanges(value, keptIn) : []
      return {
        kind: "code" as const,
        html: highlighter.highlight(value, {
          lang: "markdown",
          decorations: ranges.map((range) => ({ range, ...KEPT_DECORATION })),
        }).html,
      }
    }
    const lines =
      keptIn === undefined
        ? null
        : keptJsonLines(value, keptIn).flatMap((line, i) =>
            line.kept ? [i + 1] : []
          )
    return {
      kind: "code" as const,
      html: highlighter.highlight(JSON.stringify(value, null, 2), {
        lang: "json",
        decorations: lines?.map((line) => ({
          lines: line,
          ...KEPT_DECORATION,
        })),
      }).html,
    }
  }, [value, keptIn, view])

  // The kept parts can sit far down a raw page, so the pane opens on them.
  const pane = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const first = pane.current?.querySelector<HTMLElement>("[data-kept]")
    if (pane.current && first) pane.current.scrollTop = first.offsetTop - 16
  }, [content])

  return (
    <div
      ref={pane}
      className="relative max-h-[65vh] min-h-0 overflow-auto rounded-xl border bg-background"
    >
      {content.kind === "preview" ? (
        <div className="typeset typeset-compact p-4">
          <Markdown components={MARKDOWN_COMPONENTS}>{content.doc}</Markdown>
        </div>
      ) : (
        <>
          <style href="tanstack-highlight-theme" precedence="default">
            {THEME_CSS}
          </style>
          <div
            className="font-mono text-xs leading-relaxed [&_pre]:bg-transparent [&_pre]:p-4"
            // Escaped by TanStack Highlight: it emits text as entities.
            dangerouslySetInnerHTML={{ __html: content.html }}
          />
        </>
      )}
    </div>
  )
}
