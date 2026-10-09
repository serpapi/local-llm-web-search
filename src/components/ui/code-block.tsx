import React, { useEffect, useState } from "react"
import { bundledLanguages, codeToHtml } from "shiki/bundle/web"

import { cn } from "@/lib/utils"

export type CodeBlockProps = {
  children?: React.ReactNode
  className?: string
} & React.HTMLProps<HTMLDivElement>

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  return (
    <div
      className={cn(
        "not-typeset my-3 flex w-full flex-col overflow-clip border",
        "rounded-xl border-border bg-card text-card-foreground",
        className
      )}
      {...props}
    >
      {children}
    </div>
  )
}

export type CodeBlockCodeProps = {
  code: string
  language?: string
  className?: string
} & React.HTMLProps<HTMLDivElement>

// WHY: models fence code with whatever label they like ("output", "txt",
//      "mermaid"). Anything the web bundle doesn't know falls back to plain
//      text instead of rejecting the highlight promise.
function resolveLanguage(language: string): string {
  return language in bundledLanguages ? language : "text"
}

function CodeBlockCode({
  code,
  language = "tsx",
  className,
  ...props
}: CodeBlockCodeProps) {
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function highlight() {
      if (!code) {
        setHighlightedHtml("<pre><code></code></pre>")
        return
      }
      try {
        // NOTE: dual themes: Shiki emits CSS variables for both and the
        //       `.dark` selector below picks the right one, so the block
        //       follows the app theme without a re-highlight.
        const html = await codeToHtml(code, {
          lang: resolveLanguage(language),
          themes: { light: "github-light", dark: "github-dark" },
          defaultColor: false,
        })
        if (!cancelled) setHighlightedHtml(html)
      } catch (err) {
        console.warn("[CodeBlockCode] highlight failed:", err)
        if (!cancelled) setHighlightedHtml(null)
      }
    }
    void highlight()
    return () => {
      cancelled = true
    }
  }, [code, language])

  const classNames = cn(
    "w-full overflow-x-auto font-mono text-[13px] [&>pre]:px-4 [&>pre]:py-4",
    "[&_.shiki]:bg-(--shiki-light-bg) [&_.shiki]:text-(--shiki-light) [&_.shiki_span]:text-(--shiki-light)",
    "dark:[&_.shiki]:bg-(--shiki-dark-bg) dark:[&_.shiki]:text-(--shiki-dark) dark:[&_.shiki_span]:text-(--shiki-dark)",
    className
  )

  // SSR fallback: render plain code if not hydrated yet
  return highlightedHtml ? (
    <div
      className={classNames}
      dangerouslySetInnerHTML={{ __html: highlightedHtml }}
      {...props}
    />
  ) : (
    <div className={classNames} {...props}>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  )
}

export type CodeBlockGroupProps = React.HTMLAttributes<HTMLDivElement>

function CodeBlockGroup({
  children,
  className,
  ...props
}: CodeBlockGroupProps) {
  return (
    <div
      className={cn("flex items-center justify-between", className)}
      {...props}
    >
      {children}
    </div>
  )
}

export { CodeBlockGroup, CodeBlockCode, CodeBlock }
