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
const markdownRehypePlugins = [[rehypeKatex, { errorColor: "currentColor", strict: false, throwOnError: false }]] as const;
const inlineMarkdownComponents = {
  p({ children }: { children?: ReactNode }) {
    return <>{children}</>;
  },
} as const;
const latexInlineDelimiter = /\\{1,2}\(([^\n]+?)\\{1,2}\)/g;
const latexDisplayDelimiter = /\\{1,2}\[([\s\S]+?)\\{1,2}\]/g;
const mathTag = /\[\/math\]([\s\S]*?)\[\/math\]/g;
const inlineTag = /\[\/inline\]([\s\S]*?)\[\/inline\]/g;
const markdownMathSpan = /(\$\$[\s\S]*?\$\$|\$(?!\$)(?:\\.|[^$])*\$)/g;
const bareLatexEnvironment = /\\begin\{([A-Za-z*]+)\}[\s\S]*?\\end\{\1\}/g;
const decimalListMath = /^-?\d+(?:\.\d+)?(?:\s*,\s*-?\d+(?:\.\d+)?)+$/;
const expressionListMath = /(?:[A-Za-z0-9(){}_.]+|\.\.\.|…)\s*(?:,|\\to|\\rightarrow|→|\+|-|=|\\times|\\cdot|\*)/;
const latexCommandNames = new Set([
  "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon", "Phi", "Psi", "Omega",
  "Leftarrow", "Rightarrow", "Leftrightarrow",
  "alpha", "approx", "arg", "bar", "begin", "beta", "bmod", "bmatrix", "binom", "cap", "cases",
  "cdot", "cdots", "chi", "choose", "cos", "cup", "delta", "dfrac", "div", "dot", "dots", "ddot",
  "end", "epsilon", "equiv", "eta", "exists", "exp", "forall", "frac", "gamma", "ge", "geq",
  "hat", "in", "infty", "int", "iota", "kappa", "lambda", "land", "ldots", "le", "left",
  "leftarrow", "leftrightarrow", "leq", "lim", "ln", "log", "lor", "mapsto", "mathrm", "mathbf",
  "mathit", "matrix", "max", "min", "mod", "mp", "mu", "nabla", "neg", "neq", "notin", "nu",
  "omega", "operatorname", "overline", "phi", "pi", "pm", "pmatrix", "pmod", "prod", "psi",
  "qquad", "quad", "rho", "right", "rightarrow", "sigma", "sin", "sqrt", "subset", "subseteq",
  "sum", "supset", "supseteq", "tan", "tau", "text", "tfrac", "theta", "tilde", "times", "to",
  "underline", "upsilon", "varepsilon", "varphi", "varpi", "varrho", "varsigma", "vartheta", "vec",
  "xi", "zeta",
]);

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
      if (segment.startsWith("`") && segment.endsWith("`")) return repairInlineCodeMath(segment);
      const normalized = normalizeDisplayMathBlocks(repairDisplayMathDelimiterSpillover(
        repairBinaryTransitionMathSpillover(repairInlineDisplayMathDelimiters(normalizeMathDelimiters(escapeCurrencyDollarsPreservingMath(repairMalformedInlineMath(repairMalformedProseMath(normalizeEscapedMarkdownNewlines(segment))))))),
      ));
      return normalized
        .split(markdownMathSpan)
        .map((part) => {
          if (part.startsWith("$")) return sanitizeMathMarkdownSegment(part);
          return wrapBareCircuitMath(wrapBareLatexMath(part));
        })
        .join("");
    })
    .join("");
}

function normalizeEscapedMarkdownNewlines(text: string) {
  return text.replace(/\\n(?=(?:[ \t]*(?:\$?\s*[-*+]\s|\d+[.)]\s|#{1,6}\s)|\s*$))/g, "\n");
}

function normalizeMathDelimiters(text: string) {
  return text
    .replace(mathTag, (_match, body: string) => `$$${body.trim()}$$`)
    .replace(inlineTag, (_match, body: string) => `$${body.trim()}$`)
    .replace(latexInlineDelimiter, (_match, body: string) => `$${body.trim()}$`)
    .replace(latexDisplayDelimiter, (_match, body: string) => `$$${body.trim()}$$`);
}

function repairDisplayMathDelimiterSpillover(text: string) {
  return text
    .replace(
      /\$(?!\$)([\s\S]*?\\begin\{([A-Za-z*]+)\}[\s\S]*?\\end\{\2\})\$\$/g,
      (_match, body: string) => `$$${body.trim()}$$`,
    )
    .replace(
      /\$\$([\s\S]*?\\begin\{([A-Za-z*]+)\}[\s\S]*?\\end\{\2\})\$(?!\$)/g,
      (_match, body: string) => `$$${body.trim()}$$`,
    )
    .replace(
      /(^|\n)([ \t]*(?:\\frac|\\begin\{cases\})[\s\S]*?\\end\{cases\})\$\$/g,
      (_match, lead: string, body: string) => `${lead}$$${body.trim()}$$`,
    );
}

function repairInlineDisplayMathDelimiters(text: string) {
  return text.replace(/\$\$([^\n$]{1,80})\$\$/g, (match, body: string, offset: number, source: string) => {
    const normalizedBody = body.trim();
    if (!normalizedBody || !isLikelyInlineMathBody(normalizedBody)) return match;
    if (!hasSameLineTextAround(source, offset, offset + match.length)) return match;
    return `$${normalizedBody}$`;
  });
}

function hasSameLineTextAround(source: string, start: number, end: number) {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const lineEndIndex = source.indexOf("\n", end);
  const lineEnd = lineEndIndex === -1 ? source.length : lineEndIndex;
  const before = source.slice(lineStart, start).trim();
  const after = source.slice(end, lineEnd).trim();
  return Boolean(before || after);
}

function normalizeDisplayMathBlocks(text: string) {
  return text.replace(/\$\$([\s\S]*?)\$\$/g, (_match, body: string) => {
    const normalized = body.trim();
    if (!normalized) return "$$$$";
    return `\n\n$$\n${normalized}\n$$\n\n`;
  });
}

function repairInlineCodeMath(segment: string) {
  const body = segment.slice(1, -1);
  const cleaned = body
    .replace(/\$([A-Za-z0-9_{}\\^+\-.]+)\$/g, (_match, token: string) => token.replace(/\\_/g, "_"))
    .replace(/\$(?=\s*\\[A-Za-z]+|\s*[A-Za-z0-9(])/g, "")
    .replace(/(?<=[A-Za-z0-9)}])\$/g, "");
  if (!isLikelyMathInlineCode(cleaned)) return `\`${cleaned}\``;
  return `$${sanitizeKatexBody(normalizeLooseMathBody(cleaned))}$`;
}

function isLikelyMathInlineCode(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/\\[A-Za-z]+/.test(trimmed)) return true;
  if (/\d+\s*\^\s*\d+/.test(trimmed)) return true;
  if (/\b[A-Za-z]\s*(?:\\times|\*)\s*\d/.test(trimmed)) return true;
  return false;
}

function repairMalformedProseMath(text: string) {
  return text
    .split("\n")
    .map((line) => isMalformedProseMathLine(line) ? repairMalformedProseMathLine(line) : line)
    .join("\n");
}

function isMalformedProseMathLine(line: string) {
  return (
    /^\s*\$\s*[-*+]\s+/.test(line) ||
    (/\\text\{[^{}]*[\u3400-\u9fff][^{}]*\}/.test(line) && /\${2,}\s*(?:\\to|\\rightarrow|→)\s*\${2,}\$?/.test(line))
  );
}

function repairMalformedProseMathLine(line: string) {
  return line
    .replace(/^(\s*)\$\s*([-*+]\s+)/, "$1$2")
    .replace(/\\text\{([^{}]*)\}/g, "$1")
    .replace(/\${2,}\s*(\\to|\\rightarrow|→)\s*\${2,}\$?/g, (_match, arrow: string) => {
      const normalizedArrow = arrow === "→" ? "\\to" : arrow;
      return ` $${normalizedArrow}$ `;
    })
    .replace(/\s+([，。；：！？、])/g, "$1")
    .replace(/([“（])\s+/g, "$1")
    .replace(/\s+([”）])/g, "$1");
}

function repairMalformedInlineMath(text: string) {
  return text
    .replace(
      /(\([^)]+?\)\s*\d+)\s+\$\s*(\\to|\\rightarrow|→)\s*([^$\n]+?)\$([.…]+)(\)?\s*\d+)/g,
      (_match, left: string, arrow: string, right: string, dots: string, suffix: string) => {
        const normalizedArrow = arrow === "→" ? "\\to" : arrow;
        const ellipsis = dots.includes("…") ? "\\ldots" : "\\ldots";
        return `$${normalizeLooseMathBody(`${left} ${normalizedArrow} ${right}${ellipsis}${suffix}`)}$`;
      },
    )
    .replace(
      /(\S(?:[^$\n]{0,48}\S)?)\s+\$\s*(\\to|\\rightarrow|→)\s*([^$\n]+?)\$/g,
      (match, left: string, arrow: string, right: string) => {
        if (!/[0-9A-Za-z)]/.test(left) || /[\u3400-\u9fff]$/.test(left)) return match;
        const normalizedArrow = arrow === "→" ? "\\to" : arrow;
        return `$${normalizeLooseMathBody(`${left} ${normalizedArrow} ${right}`)}$`;
      },
    );
}

function normalizeLooseMathBody(value: string) {
  return value
    .replace(/[.…]{3,}|…/g, "\\ldots")
    .replace(/\b([A-Za-z0-9.]+|\([^)]+\))\s*_(\d+)\b/g, "$1_{$2}")
    .replace(/(\([^)]+\))\s*(\d+)\b/g, "$1_{$2}")
    .replace(/\b([A-Za-z])\s+(?=\\times\b)/g, "$1 ");
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
  if (decimalListMath.test(value)) return true;
  if (/^\d+(?:[.,]\d+)?$/.test(value)) return true;
  if (/^[A-Za-z][A-Za-z0-9_{}\\^+\-.]*$/.test(value)) return true;
  if (expressionListMath.test(value) && /[\d\\_^=+\-*/<>]|→|≤|≥|≠|≈|[{}]/.test(value)) return true;
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
  let normalized = normalizeMathVerticalBars(normalizeLooseMathBody(body)).replace(/\\(?=\d)/g, "").replace(/\\_/g, "_");
  const hdlIdentifier = hdlIdentifierMathBody(normalized);
  if (hdlIdentifier) return hdlIdentifier;
  if (!/\\(?:text|mathrm|operatorname)\s*\{/.test(normalized)) {
    normalized = normalized.replace(/([\u3400-\u9fff，。、；：！？、]+)/g, "\\text{$1}");
  }
  return normalized;
}

function normalizeMathVerticalBars(body: string) {
  const positions: number[] = [];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "|" && !isEscapedAt(body, index)) positions.push(index);
  }
  if (!positions.length) return body;
  const paired = positions.length % 2 === 0;
  let output = "";
  let barIndex = 0;
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === "|" && !isEscapedAt(body, index)) {
      output += paired
        ? barIndex % 2 === 0
          ? "\\lvert{}"
          : "\\rvert{}"
        : "\\vert{}";
      barIndex += 1;
    } else {
      output += body[index];
    }
  }
  return output;
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

function wrapBareLatexMath(text: string) {
  const withEnvironments = text.replace(bareLatexEnvironment, (match: string) => `\n\n$$\n${match.trim()}\n$$\n\n`);
  return wrapBarePowerSequences(withEnvironments)
    .split(markdownMathSpan)
    .map((part) => part.startsWith("$") ? part : wrapBareLatexInlineMath(part))
    .join("");
}

function wrapBarePowerSequences(text: string) {
  return text.replace(
    /(^|[^\w$`])((?:\d+\^\d+\s*,\s*){1,}\d+\^\d+(?:\s*,\s*(?:\.\.\.|…))?)/g,
    (_match, lead: string, expression: string) => `${lead}$${sanitizeKatexBody(expression)}$`,
  );
}

function wrapBareLatexInlineMath(text: string) {
  const trigger = /\\[A-Za-z]+/g;
  let output = "";
  let index = 0;
  while (index < text.length) {
    trigger.lastIndex = index;
    const match = trigger.exec(text);
    if (!match) {
      output += text.slice(index);
      break;
    }
    const slashIndex = match.index;
    const command = match[0].slice(1);
    if (!latexCommandNames.has(command)) {
      output += text.slice(index, trigger.lastIndex);
      index = trigger.lastIndex;
      continue;
    }
    const expressionStart = bareLatexExpressionStart(text, slashIndex);
    const expressionEnd = bareLatexExpressionEnd(text, slashIndex);
    if (expressionEnd <= slashIndex) {
      output += text.slice(index, trigger.lastIndex);
      index = trigger.lastIndex;
      continue;
    }
    const expression = text.slice(expressionStart, expressionEnd).trim();
    const delimiter = expression.includes("\n") ? "$$" : "$";
    output += text.slice(index, expressionStart);
    output += `${delimiter}${sanitizeKatexBody(expression)}${delimiter}`;
    index = expressionEnd;
  }
  return output;
}

function bareLatexExpressionStart(text: string, slashIndex: number) {
  let cursor = slashIndex - 1;
  while (cursor >= 0 && " \t".includes(text[cursor])) cursor -= 1;
  if (cursor < 0 || !"=+-*/(^_".includes(text[cursor])) return slashIndex;
  let start = cursor;
  while (start > 0 && !"\n\r，。；：！？、".includes(text[start - 1])) {
    if ("$`".includes(text[start - 1])) break;
    start -= 1;
  }
  return start;
}

function bareLatexExpressionEnd(text: string, slashIndex: number) {
  let cursor = slashIndex;
  while (cursor < text.length) {
    const tokenEnd = consumeLatexMathToken(text, cursor);
    if (tokenEnd <= cursor) break;
    cursor = tokenEnd;
    const spaceStart = cursor;
    while (cursor < text.length && " \t".includes(text[cursor])) cursor += 1;
    if (!startsLatexMathContinuation(text, cursor)) {
      cursor = spaceStart;
      break;
    }
  }
  while (cursor > slashIndex && " \t.,;:".includes(text[cursor - 1])) cursor -= 1;
  return cursor;
}

function startsLatexMathContinuation(text: string, index: number) {
  if (index >= text.length) return false;
  if (text[index] === "\\") {
    const match = /\\[A-Za-z]+/.exec(text.slice(index));
    return Boolean(match && latexCommandNames.has(match[0].slice(1)));
  }
  return "{}()+-*/=^_[]<>|,.".includes(text[index]) || /\d/.test(text[index]);
}

function consumeLatexMathToken(text: string, index: number) {
  if (index >= text.length || "\n\r，。；：！？、$`".includes(text[index])) return index;
  if (text[index] === "\\") {
    const match = /\\[A-Za-z]+/.exec(text.slice(index));
    if (!match || !latexCommandNames.has(match[0].slice(1))) return index;
    let cursor = index + match[0].length;
    if (match[0].slice(1) === "left" || match[0].slice(1) === "right") {
      while (cursor < text.length && " \t".includes(text[cursor])) cursor += 1;
      if (cursor < text.length && !"\n\r".includes(text[cursor])) cursor += 1;
    }
    while (true) {
      const groupEnd = consumeBracedGroup(text, cursor);
      if (groupEnd <= cursor) break;
      cursor = groupEnd;
    }
    return cursor;
  }
  if (text[index] === "{") return consumeBracedGroup(text, index);
  if (/\d/.test(text[index])) {
    let cursor = index + 1;
    while (cursor < text.length && /[0-9.eE+-]/.test(text[cursor])) cursor += 1;
    return cursor;
  }
  if ("()+-*/=^_[]<>|,.".includes(text[index])) return index + 1;
  return index;
}

function consumeBracedGroup(text: string, index: number) {
  if (index >= text.length || text[index] !== "{") return index;
  let depth = 0;
  for (let cursor = index; cursor < text.length; cursor += 1) {
    if (text[cursor] === "\\") {
      cursor += 1;
      continue;
    }
    if (text[cursor] === "{") depth += 1;
    if (text[cursor] === "}") {
      depth -= 1;
      if (depth === 0) return cursor + 1;
    }
  }
  return index;
}
