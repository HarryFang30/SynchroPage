/**
 * Two micromark text constructs that complete `micromark-extension-math-extended`
 * for markdown written by a language model:
 *
 * - single-dollar inline math (`$x$`) with Pandoc's currency guards: the
 *   opening `$` must not be followed by whitespace unless the closing `$` is
 *   preceded by whitespace too, the closing `$` must not be preceded by
 *   whitespace and must not be followed by a digit. When a `$` fails as a
 *   closer but could open a span of its own, the earlier `$` is given up as
 *   literal text, so `$5, and $x$` renders "$5, and " followed by math `x`
 *   instead of one span from 5 to x.
 * - `\[ ... \]` inside a sentence. The library only recognises `\[` at the
 *   start of a line (as a block); OpenAI-style models also write it mid-line.
 *
 * Both emit the same token types as the library's constructs, so
 * `mdast-util-math` turns them into `inlineMath` nodes unchanged. Unterminated
 * spans fail at the end of the paragraph and every consumed character is given
 * back to the paragraph, which is what keeps one stray `$` from italicising the
 * rest of a page. Inside a span nothing is rewritten.
 */
import { asciiDigit, markdownLineEnding } from "micromark-util-character";
import type { Code, Construct, Effects, Event, Extension, State, Token, TokenizeContext } from "micromark-util-types";

const dollarSign = 36;
const space = 32;
const backslash = 92;
const leftSquareBracket = 91;
const rightSquareBracket = 93;

type TokenType = Token["type"];
const mathText = "mathText" as TokenType;
const mathTextSequence = "mathTextSequence" as TokenType;
const mathTextData = "mathTextData" as TokenType;
const mathTextPadding = "mathTextPadding" as TokenType;
const spaceToken = "space" as TokenType;
const lineEndingToken = "lineEnding" as TokenType;

export function llmMathText(): Extension {
  return {
    text: {
      [dollarSign]: singleDollarMath,
      [backslash]: bracketMath,
    },
  };
}

const singleDollarMath: Construct = {
  name: "mathText",
  tokenize: tokenizeSingleDollar,
  resolve: resolveMathText,
  previous: previousDollar,
};

const bracketMath: Construct = {
  name: "mathText",
  tokenize: tokenizeBracket,
  resolve: resolveMathText,
  previous: previousBackslash,
};

function previousDollar(this: TokenizeContext, code: Code) {
  return code !== dollarSign || this.events[this.events.length - 1][1].type === "characterEscape";
}

function previousBackslash(this: TokenizeContext, code: Code) {
  return code !== backslash || this.events[this.events.length - 1][1].type === "characterEscape";
}

function isWhitespace(code: Code) {
  return code === space || markdownLineEnding(code);
}

function tokenizeSingleDollar(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let paddedOpen = false;
  let spaceBefore = false;
  let closing: Token;

  return start;

  function start(code: Code) {
    effects.enter(mathText);
    effects.enter(mathTextSequence);
    effects.consume(code);
    return afterOpen;
  }

  function afterOpen(code: Code) {
    // `$$` and longer fences belong to the library's construct.
    if (code === dollarSign || code === null) return nok(code);
    effects.exit(mathTextSequence);
    paddedOpen = isWhitespace(code);
    return between(code);
  }

  function between(code: Code): State | undefined {
    if (code === null) return nok(code);
    if (code === dollarSign) {
      closing = effects.enter(mathTextSequence);
      effects.consume(code);
      return afterClose;
    }
    if (code === space) {
      effects.enter(spaceToken);
      effects.consume(code);
      effects.exit(spaceToken);
      spaceBefore = true;
      return between;
    }
    if (markdownLineEnding(code)) {
      effects.enter(lineEndingToken);
      effects.consume(code);
      effects.exit(lineEndingToken);
      spaceBefore = true;
      return between;
    }
    effects.enter(mathTextData);
    return data(code);
  }

  function data(code: Code): State | undefined {
    if (code === null || code === space || code === dollarSign || markdownLineEnding(code)) {
      effects.exit(mathTextData);
      spaceBefore = false;
      return between(code);
    }
    effects.consume(code);
    return data;
  }

  function afterClose(code: Code): State | undefined {
    if (code === dollarSign) {
      effects.consume(code);
      return longerRun;
    }
    const closes = !asciiDigit(code) && (!spaceBefore || paddedOpen);
    if (closes) {
      effects.exit(mathTextSequence);
      effects.exit(mathText);
      return ok(code);
    }
    // Not a closer. If this `$` could open a span itself, the span we are in
    // is the wrong one: give the opening `$` back as text and let the parser
    // retry from here.
    if (code !== null && !isWhitespace(code)) return nok(code);
    closing.type = mathTextData;
    spaceBefore = false;
    return data(code);
  }

  // `$x$$`: a longer run cannot close a single-dollar span (CommonMark code
  // span semantics); the run is data and the search goes on.
  function longerRun(code: Code): State | undefined {
    if (code === dollarSign) {
      effects.consume(code);
      return longerRun;
    }
    closing.type = mathTextData;
    spaceBefore = false;
    return data(code);
  }
}

function tokenizeBracket(this: TokenizeContext, effects: Effects, ok: State, nok: State): State {
  let closing: Token;

  return start;

  function start(code: Code) {
    effects.enter(mathText);
    effects.enter(mathTextSequence);
    effects.consume(code);
    return afterBackslash;
  }

  function afterBackslash(code: Code) {
    if (code !== leftSquareBracket) return nok(code);
    effects.consume(code);
    effects.exit(mathTextSequence);
    return between;
  }

  function between(code: Code): State | undefined {
    if (code === null) return nok(code);
    if (code === backslash) {
      closing = effects.enter(mathTextSequence);
      effects.consume(code);
      return afterClosingBackslash;
    }
    if (code === space) {
      effects.enter(spaceToken);
      effects.consume(code);
      effects.exit(spaceToken);
      return between;
    }
    if (markdownLineEnding(code)) {
      effects.enter(lineEndingToken);
      effects.consume(code);
      effects.exit(lineEndingToken);
      return between;
    }
    effects.enter(mathTextData);
    return data(code);
  }

  function data(code: Code): State | undefined {
    if (code === null || code === space || code === backslash || markdownLineEnding(code)) {
      effects.exit(mathTextData);
      return between(code);
    }
    effects.consume(code);
    return data;
  }

  function afterClosingBackslash(code: Code): State | undefined {
    if (code === rightSquareBracket) {
      effects.consume(code);
      effects.exit(mathTextSequence);
      effects.exit(mathText);
      return ok;
    }
    // `\\` (a TeX line break) or a command such as `\alpha`: data, not a closer.
    closing.type = mathTextData;
    return data(code);
  }
}

/**
 * Strips one layer of padding and merges data runs, exactly as the library
 * does, so `$ x $` yields the value `x` and multi-line spans keep their line
 * endings.
 */
function resolveMathText(events: Event[]) {
  let tailExitIndex = events.length - 4;
  let headEnterIndex = 3;
  let index: number;
  let enter: number | undefined;

  if (
    (events[headEnterIndex][1].type === lineEndingToken || events[headEnterIndex][1].type === spaceToken) &&
    (events[tailExitIndex][1].type === lineEndingToken || events[tailExitIndex][1].type === spaceToken)
  ) {
    index = headEnterIndex;
    while (++index < tailExitIndex) {
      if (events[index][1].type === mathTextData) {
        events[tailExitIndex][1].type = mathTextPadding;
        events[headEnterIndex][1].type = mathTextPadding;
        headEnterIndex += 2;
        tailExitIndex -= 2;
        break;
      }
    }
  }

  index = headEnterIndex - 1;
  tailExitIndex++;
  while (++index <= tailExitIndex) {
    if (enter === undefined) {
      if (index !== tailExitIndex && events[index][1].type !== lineEndingToken) enter = index;
    } else if (index === tailExitIndex || events[index][1].type === lineEndingToken) {
      events[enter][1].type = mathTextData;
      if (index !== enter + 2) {
        events[enter][1].end = events[index - 1][1].end;
        events.splice(enter + 2, index - enter - 2);
        tailExitIndex -= index - enter - 2;
        index = enter + 2;
      }
      enter = undefined;
    }
  }
  return events;
}
