import { createContext, memo, useContext } from "react"
import ReactMarkdown from "react-markdown"
import rehypeExternalLinks from "rehype-external-links"
import remarkGfm from "remark-gfm"

import { CodeBlock, CodeBlockCode } from "./code-block"
import type { Components, Options } from "react-markdown"

import { cn } from "@/lib/utils"

export type MarkdownProps = {
  children: string
  className?: string
  /**
   * Typeset preset class (`typeset-chat`, `typeset-compact`, ...). Presets
   * only set CSS variables, so a wrapper can still override with utilities.
   */
  preset?: string
  components?: Partial<Components>
}

function extractLanguage(className?: string): string {
  if (!className) return "plaintext"
  const match = className.match(/language-(\w+)/)
  return match ? match[1] : "plaintext"
}

// WHY: the answer arrives in one round trip (no streaming), so a single
//      ReactMarkdown pass is enough. shadcn/typeset styles every block the
//      model can emit (headings, lists, links, tables, blockquotes) from
//      one CSS file that reads the app's theme tokens, so the only React
//      overrides left are fenced code (Shiki highlighting, opted out of
//      typeset), the horizontal-scroll wrapper typeset documents for wide
//      tables, and images, which render as links. Model-emitted links open
//      in a new tab via rehype-external-links, the same way the Sources
//      panel does.
const REMARK_PLUGINS: Options["remarkPlugins"] = [remarkGfm]
const REHYPE_PLUGINS: Options["rehypePlugins"] = [
  [rehypeExternalLinks, { target: "_blank", rel: ["noreferrer", "noopener"] }],
]

// True inside a Markdown link, where an image must not become a second,
// nested link.
const InsideLink = createContext(false)

const INITIAL_COMPONENTS: Partial<Components> = {
  code: function CodeComponent({ className, children, ...props }) {
    const startLine = props.node?.position?.start.line
    const endLine = props.node?.position?.end.line
    const isInline = !startLine || startLine === endLine

    if (isInline) {
      return (
        <code className={className} {...props}>
          {children}
        </code>
      )
    }

    const language = extractLanguage(className)

    return (
      <CodeBlock className={className}>
        <CodeBlockCode code={children as string} language={language} />
      </CodeBlock>
    )
  },
  pre: function PreComponent({ children }) {
    return <>{children}</>
  },
  a: function LinkComponent({ node: _node, ...props }) {
    return (
      <InsideLink.Provider value={true}>
        <a {...props} />
      </InsideLink.Provider>
    )
  },
  // WHY: answers quote search results, so an image URL comes from a page
  //      nobody vetted. A link lets the reader choose to open it instead of
  //      the browser fetching it on render.
  img: function ImageLink({ src, alt }) {
    const insideLink = useContext(InsideLink)
    const url = typeof src === "string" ? src : ""
    const label = alt || url
    if (insideLink || !url) return <>{label}</>
    return (
      <a href={url} target="_blank" rel="noreferrer noopener">
        {label}
      </a>
    )
  },
  // Flight / hotel comparisons come back as wide tables; typeset's own
  // scroll wrapper keeps them inside the bubble instead of overflowing it.
  table: function TableComponent({ children, ...props }) {
    return (
      <div className="typeset-scroll">
        <table {...props}>{children}</table>
      </div>
    )
  },
}

function MarkdownComponent({
  children,
  className,
  preset = "typeset-chat",
  components = INITIAL_COMPONENTS,
}: MarkdownProps) {
  return (
    <div className={cn("typeset", preset, className)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

const Markdown = memo(MarkdownComponent)
Markdown.displayName = "Markdown"

export { Markdown }
