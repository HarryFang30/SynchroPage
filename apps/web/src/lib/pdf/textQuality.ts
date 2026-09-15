/**
 * Detects a text layer that extraction turned into noise.
 *
 * Slide decks whose formulas are drawn with an embedded font and no usable
 * ToUnicode map come out as runs of stray ASCII symbols and digits
 * ("! = 0 , ̅ & (\") = ' 0"), private-use glyphs, or "(cid:N)" markers. The
 * prose usually survives, so the text is not empty and the sparse-text route
 * never fires; these pages need the PDF page itself, or a transcription of
 * it, to be taught properly.
 *
 * Pure module: no React, no DOM.
 */

export type SourceTextQuality = {
  tokens: number;
  /** Tokens with no letters that only make sense as broken glyph output. */
  junkTokens: number;
  /** junkTokens / tokens; 0 when there are no tokens. */
  junkRatio: number;
  /** Characters no extractor writes on purpose: private-use, U+FFFD, "(cid:N)". */
  hardMarkers: number;
  /** Up to twelve of the junk tokens, for the inspector and for tuning. */
  samples: string[];
  garbled: boolean;
};

/** Parser name of a page whose text a model transcribed from the page image. */
export const TRANSCRIPTION_PARSER = "model-transcription";

const CID_MARKERS = /\(cid:\d+\)/gu;
const PRIVATE_USE_OR_REPLACEMENT = /[-�\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/gu;
const HAS_LETTER = /\p{L}/u;
const HAS_HARD_MARKER = /\(cid:\d+\)|[-�\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;
/** A stray quote, bang, dollar or caret never stands alone in prose; a glyph id written as a character does. */
const STRONG_JUNK_CHAR = /[!"$'@^_`~]/u;
/** Symbol runs mixing these with brackets or each other ("#$, %&, (\"), <)) are broken glyphs too. */
const SYMBOL_JUNK_CHAR = /[!"#$%&'<>@^_`|~]/u;
const COMBINING_ONLY = /^\p{M}+$/u;
const ASCII_SYMBOL_OR_DIGIT_ONLY = /^[!-/:-@[-`{-~]+$/u;
/** What prose and code legitimately leave standing alone: numbers, bullets, list markers, operators. */
const BENIGN_STANDALONE =
  /^(?:\d+(?:[.,:]\d+)*%?|[-–—*•·+=/\\|.,:;?()[\]{}&<>#%]|\(?\d{1,2}[.)]|[a-z][.)]|<=|>=|==|!=|->|<-|=>|<->|&&|\|\||::|\.\.\.|--|\*\*|\+\+)$/iu;

/** Minimum junk tokens before a ratio can flag a page. */
const GARBLED_MIN_JUNK_TOKENS = 2;
/** Share of junk tokens that marks the layer as unreadable. */
const GARBLED_JUNK_RATIO = 0.1;
/** This many junk tokens flag the page regardless of its prose. */
const GARBLED_ABSOLUTE_JUNK_TOKENS = 10;
const GARBLED_MIN_HARD_MARKERS = 3;

/** Noise on its own: a character that never stands alone, or a symbol run built from such characters. */
function tokenIsStrongJunk(token: string) {
  if (HAS_LETTER.test(token)) return false;
  if (HAS_HARD_MARKER.test(token)) return true;
  if (BENIGN_STANDALONE.test(token)) return false;
  if (STRONG_JUNK_CHAR.test(token)) return true;
  return token.length >= 2 && ASCII_SYMBOL_OR_DIGIT_ONLY.test(token) && SYMBOL_JUNK_CHAR.test(token);
}

/**
 * Noise only in company: a lone digit, a short symbol, or a detached
 * combining mark. PDF.js splits "ĥ" into "̂ h" in perfectly good papers and
 * slides say "x > 0" all the time, so alone these prove nothing; next to a
 * stray quote or dollar sign each is one more broken glyph.
 */
function tokenIsWeakJunk(token: string) {
  if (HAS_LETTER.test(token)) return false;
  if (COMBINING_ONLY.test(token) || /^\d$/u.test(token)) return true;
  return token.length <= 3 && ASCII_SYMBOL_OR_DIGIT_ONLY.test(token);
}

export function sourceTextQuality(text: string): SourceTextQuality {
  const normalized = String(text || "").replace(/\r\n?/g, "\n");
  const tokens = normalized.split(/\s+/u).filter(Boolean);
  const hardMarkers =
    (normalized.match(CID_MARKERS) || []).length + (normalized.match(PRIVATE_USE_OR_REPLACEMENT) || []).length;
  const strong = tokens.map(tokenIsStrongJunk);
  const samples: string[] = [];
  let junkTokens = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const neighbourIsStrong = Boolean(strong[index - 1]) || Boolean(strong[index + 1]);
    const junk = strong[index] || (neighbourIsStrong && tokenIsWeakJunk(tokens[index]));
    if (!junk) continue;
    junkTokens += 1;
    if (samples.length < 12) samples.push(tokens[index]);
  }
  const junkRatio = tokens.length ? junkTokens / tokens.length : 0;
  const garbled =
    hardMarkers >= GARBLED_MIN_HARD_MARKERS ||
    junkTokens >= GARBLED_ABSOLUTE_JUNK_TOKENS ||
    (junkTokens >= GARBLED_MIN_JUNK_TOKENS && junkRatio >= GARBLED_JUNK_RATIO);
  return { tokens: tokens.length, junkTokens, junkRatio, hardMarkers, samples, garbled };
}

/** True when the extracted text of a page cannot be trusted to carry its formulas. */
export function sourceTextLooksGarbled(text: string) {
  return sourceTextQuality(text).garbled;
}
