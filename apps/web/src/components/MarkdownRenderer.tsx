import "katex/dist/katex.min.css";
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { markdownRehypePlugins, markdownRemarkPlugins, prepareMarkdownForRendering } from "../lib/markdown/mathMarkdown";

const inlineMarkdownComponents = {
  p({ children }: { children?: ReactNode }) {
    return <>{children}</>;
  },
} as const;

/**
 * Renders model-written Markdown with LaTeX. Math boundaries come from the
 * markdown tokenizer (see `lib/markdown/mathMarkdown.ts`); nothing here
 * rewrites the text.
 */
export default function MarkdownRenderer({
  className,
  text,
  inline = false,
  components,
}: {
  className: string;
  text: string;
  inline?: boolean;
  /** Extra element renderers (for example a blockquote that styles teaching devices). */
  components?: Components;
}) {
  const mergedComponents = inline ? { ...inlineMarkdownComponents, ...components } : components;
  const content = (
    <ReactMarkdown
      remarkPlugins={markdownRemarkPlugins(inline)}
      rehypePlugins={markdownRehypePlugins}
      components={mergedComponents as never}
    >
      {prepareMarkdownForRendering(text)}
    </ReactMarkdown>
  );
  return inline ? <span className={className}>{content}</span> : <div className={className}>{content}</div>;
}
