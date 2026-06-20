import "katex/dist/katex.min.css";
import type { ReactNode } from "react";
import rehypeKatex from "rehype-katex";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

const markdownRemarkPlugins = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: true }],
] as const;
const markdownRehypePlugins = [[rehypeKatex, { strict: false, throwOnError: false }]] as const;
const inlineMarkdownComponents = {
  p({ children }: { children?: ReactNode }) {
    return <>{children}</>;
  },
} as const;
const latexInlineDelimiter = /\\{1,2}\(([^\n]+?)\\{1,2}\)/g;
const latexDisplayDelimiter = /\\{1,2}\[([\s\S]+?)\\{1,2}\]/g;
const mathTag = /\[\/math\]([\s\S]*?)\[\/math\]/g;
const inlineTag = /\[\/inline\]([\s\S]*?)\[\/inline\]/g;

export default function MarkdownRenderer({ className, text, inline = false }: { className: string; text: string; inline?: boolean }) {
  const renderedText = inline ? displayMathAsInline(preprocessMathMarkdown(text)) : preprocessMathMarkdown(text);
  const content = (
      <ReactMarkdown
        remarkPlugins={markdownRemarkPlugins as never}
        rehypePlugins={markdownRehypePlugins as never}
        components={inline ? inlineMarkdownComponents as never : undefined}
      >
        {renderedText}
      </ReactMarkdown>
  );
  return inline ? <span className={className}>{content}</span> : <div className={className}>{content}</div>;
}

function displayMathAsInline(text: string) {
  return text.replace(/\$\$([\s\S]*?)\$\$/g, (_match, body: string) => `$${body.trim()}$`);
}

function preprocessMathMarkdown(text: string) {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((segment) => {
      if (segment.startsWith("```")) return segment;
      return preprocessMarkdownTextSegment(segment);
    })
    .join("");
}

function preprocessMarkdownTextSegment(text: string) {
  return text
    .split(/(`[^`\n]*`)/g)
    .map((segment) => {
      if (segment.startsWith("`") && segment.endsWith("`")) return cleanupInlineCodeMathDollars(segment);
      const normalized = repairBinaryTransitionMathSpillover(normalizeMathDelimiters(escapeCurrencyDollarsPreservingMath(segment)));
      return normalized
        .split(/(\$\$[\s\S]*?\$\$|\$(?!\$)(?:\\.|[^$])*\$)/g)
        .map((part) => {
          if (part.startsWith("$")) return sanitizeMathMarkdownSegment(part);
          return wrapBareCircuitMath(part);
        })
        .join("");
    })
    .join("");
}

function normalizeMathDelimiters(text: string) {
  return text
    .replace(mathTag, (_match, body: string) => `$$${body.trim()}$$`)
    .replace(inlineTag, (_match, body: string) => `$${body.trim()}$`)
    .replace(latexInlineDelimiter, (_match, body: string) => `$${body.trim()}$`)
    .replace(latexDisplayDelimiter, (_match, body: string) => `$$${body.trim()}$$`);
}

function cleanupInlineCodeMathDollars(segment: string) {
  return segment.replace(/\$([A-Za-z0-9_{}\\^+\-.]+)\$/g, (_match, token: string) => token.replace(/\\_/g, "_"));
}

function escapeCurrencyDollarsPreservingMath(text: string) {
  let output = "";
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("$$", index) && !isEscapedAt(text, index)) {
      const close = findNextDoubleDollar(text, index + 2);
      if (close !== -1) {
        output += text.slice(index, close + 2);
        index = close + 2;
        continue;
      }
    }

    if (text[index] === "$" && !isEscapedAt(text, index) && text[index - 1] !== "$" && text[index + 1] !== "$") {
      const close = findNextSingleDollar(text, index + 1);
      if (close !== -1) {
        const body = text.slice(index + 1, close);
        if (isLikelyInlineMathBody(body)) {
          output += text.slice(index, close + 1);
          index = close + 1;
          continue;
        }
      }
      output += /\d/.test(text[index + 1] || "") ? "\\$" : "$";
      index += 1;
      continue;
    }

    output += text[index];
    index += 1;
  }
  return output;
}

function isEscapedAt(text: string, index: number) {
  let slashCount = 0;
  for (let cursor = index - 1; cursor >= 0 && text[cursor] === "\\"; cursor -= 1) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function findNextSingleDollar(text: string, start: number) {
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "$" && !isEscapedAt(text, index) && text[index - 1] !== "$" && text[index + 1] !== "$") {
      return index;
    }
  }
  return -1;
}

function findNextDoubleDollar(text: string, start: number) {
  for (let index = start; index < text.length - 1; index += 1) {
    if (text.startsWith("$$", index) && !isEscapedAt(text, index)) return index;
  }
  return -1;
}

function isLikelyInlineMathBody(body: string) {
  const value = body.trim();
  if (!value || value.includes("\n")) return false;
  if (/^\d+(?:[.,]\d+)?$/.test(value)) return true;
  if (/^[A-Za-z][A-Za-z0-9_{}\\^+\-.]*$/.test(value)) return true;
  if (/[\\_^=+\-*/<>]|→|≤|≥|≠|≈|[{}]/.test(value)) return true;
  if (/^[01]{2,}(?:\s*(?:\\to|\\rightarrow|→)\s*[01]{2,})+$/.test(value)) return true;
  return false;
}

function repairBinaryTransitionMathSpillover(text: string) {
  return text.replace(
    /\$((?:[01]{2,}|\\cdots)(?:\s*(?:\\to|\\rightarrow|→)\s*(?:[01]{2,}|\\cdots))+)(\s*)([。；，、](?=[\u3400-\u9fff]))/g,
    (_match, expression: string, spacing: string, punctuation: string) => `$${expression}$${spacing}${punctuation}`,
  );
}

function sanitizeMathMarkdownSegment(segment: string) {
  const delimiter = segment.startsWith("$$") ? "$$" : "$";
  if (!segment.endsWith(delimiter)) return segment;
  const body = segment.slice(delimiter.length, -delimiter.length);
  return `${delimiter}${sanitizeKatexBody(body)}${delimiter}`;
}

function sanitizeKatexBody(body: string) {
  let normalized = body.replace(/\\(?=\d)/g, "").replace(/\\_/g, "_");
  const hdlIdentifier = hdlIdentifierMathBody(normalized);
  if (hdlIdentifier) return hdlIdentifier;
  if (!/\\(?:text|mathrm|operatorname)\s*\{/.test(normalized)) {
    normalized = normalized.replace(/([\u3400-\u9fff，。、；：！？、]+)/g, "\\text{$1}");
  }
  return normalized;
}

function hdlIdentifierMathBody(body: string) {
  const value = body.trim();
  if (!/^[A-Za-z][A-Za-z0-9]*_[A-Za-z][A-Za-z0-9_]*(?:\^\+)?$/.test(value)) return "";
  return `\\text{${escapeKatexText(value)}}`;
}

function escapeKatexText(value: string) {
  return value.replace(/\\/g, "\\textbackslash{}").replace(/([{}_$%&#])/g, "\\$1");
}

function wrapBareCircuitMath(text: string) {
  return text
    .replace(/^(\s*)([01]{2,}\s*(?:\\rightarrow|→)\s*[01]{2,}(?:\s*(?:\\rightarrow|→)\s*[01]{2,})+)(\s*)$/gm, (_match, lead, expression, tail) => `${lead}$$${sanitizeKatexBody(expression)}$$${tail}`)
    .replace(/^(\s*)([A-Za-z][A-Za-z0-9]*_\{?[A-Za-z0-9]+\}?(?:\^\+)?\s*=\s*[A-Za-z][A-Za-z0-9]*_\{?[A-Za-z0-9]+\}?(?:\^\+)?)(\s*)$/gm, (_match, lead, expression, tail) => `${lead}$${sanitizeKatexBody(expression)}$${tail}`)
    .replace(/\b([A-Z][A-Za-z0-9]*_\{?[A-Za-z0-9]+\}?(?:\^\+)?|[A-Z]\^\+)\b/g, (_match, token) => `$${sanitizeKatexBody(token)}$`);
}
