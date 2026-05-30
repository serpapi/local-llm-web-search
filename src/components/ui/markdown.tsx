import { marked } from "marked"
import { memo, useId, useMemo } from "react"
import ReactMarkdown from "react-markdown"
import remarkBreaks from "remark-breaks"
import remarkGfm from "remark-gfm"

import { CodeBlock, CodeBlockCode } from "./code-block"
import type { Components } from "react-markdown"

import { cn } from "@/lib/utils"

export type MarkdownProps = {
  children: string
  id?: string
  className?: string
  components?: Partial<Components>
}

function parseMarkdownIntoBlocks(markdown: string): Array<string> {
  const tokens = marked.lexer(markdown)
  return tokens.map((token) => token.raw)
}

function extractLanguage(className?: string): string {
  if (!className) return "plaintext"
  const match = className.match(/language-(\w+)/)
  return match ? match[1] : "plaintext"
}

const INITIAL_COMPONENTS: Partial<Components> = {
  code: function CodeComponent({ className, children, ...props }) {
    const startLine = props.node?.position?.start.line
    const endLine = props.node?.position?.end.line
    const isInline = !startLine || startLine === endLine

    if (isInline) {
      return (
        <span
          className={cn(
            "rounded-sm bg-primary-foreground px-1 font-mono text-sm",
            className
          )}
          {...props}
        >
          {children}
        </span>
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
  // GFM tables render as bare <table>/<th>/<td> by default — without
  // table-specific CSS they collapse visually (cells run together, no
  // dividers). These components give tables a consistent, readable look
  // that works for any tool whose output includes one (flights, and any
  // future tool that returns tabular data).
  table: function TableComponent({ className, children, ...props }) {
    return (
      <div className="my-3 overflow-x-auto rounded-lg border">
        <table
          className={cn("w-full border-collapse text-sm", className)}
          {...props}
        >
          {children}
        </table>
      </div>
    )
  },
  thead: function TheadComponent({ className, children, ...props }) {
    return (
      <thead className={cn("border-b bg-muted/60", className)} {...props}>
        {children}
      </thead>
    )
  },
  tbody: function TbodyComponent({ className, children, ...props }) {
    return (
      <tbody className={cn("divide-y divide-border", className)} {...props}>
        {children}
      </tbody>
    )
  },
  th: function ThComponent({ className, children, ...props }) {
    return (
      <th
        className={cn(
          "px-3 py-2 text-left text-xs font-semibold tracking-wide text-muted-foreground uppercase",
          className
        )}
        {...props}
      >
        {children}
      </th>
    )
  },
  td: function TdComponent({ className, children, ...props }) {
    return (
      <td
        className={cn("px-3 py-2 align-top tabular-nums", className)}
        {...props}
      >
        {children}
      </td>
    )
  },
}

const MemoizedMarkdownBlock = memo(
  function MarkdownBlock({
    content,
    components = INITIAL_COMPONENTS,
  }: {
    content: string
    components?: Partial<Components>
  }) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    )
  },
  function propsAreEqual(prevProps, nextProps) {
    return (
      prevProps.content === nextProps.content &&
      prevProps.components === nextProps.components
    )
  }
)

MemoizedMarkdownBlock.displayName = "MemoizedMarkdownBlock"

function MarkdownComponent({
  children,
  id,
  className,
  components = INITIAL_COMPONENTS,
}: MarkdownProps) {
  const generatedId = useId()
  const blockId = id ?? generatedId
  const blocks = useMemo(() => parseMarkdownIntoBlocks(children), [children])

  return (
    <div className={className}>
      {blocks.map((block, index) => (
        <MemoizedMarkdownBlock
          key={`${blockId}-block-${index}`}
          content={block}
          components={components}
        />
      ))}
    </div>
  )
}

const Markdown = memo(MarkdownComponent)
Markdown.displayName = "Markdown"

export { Markdown }
