"""Markdown math and JSON LaTeX repair utilities extracted from web_app.py.

These functions handle LaTeX backslash escaping in JSON strings, normalize
Markdown math delimiters, wrap bare LaTeX expressions, and repair common
model output issues.

All functions are pure and stateless — safe to import anywhere.
"""

from __future__ import annotations

import json
import re
from typing import Any

# ---------------------------------------------------------------------------
# LaTeX commands that MUST be JSON-escaped (i.e. need \\ in JSON strings)
# ---------------------------------------------------------------------------

_LATEX_COMMANDS_REQUIRING_JSON_ESCAPE: frozenset[str] = frozenset(
    {
        "Gamma",
        "Delta",
        "Theta",
        "Lambda",
        "Xi",
        "Pi",
        "Sigma",
        "Upsilon",
        "Phi",
        "Psi",
        "Omega",
        "Leftarrow",
        "Rightarrow",
        "Leftrightarrow",
        "alpha",
        "approx",
        "arg",
        "bar",
        "begin",
        "beta",
        "bmod",
        "bmatrix",
        "binom",
        "cap",
        "cases",
        "cdot",
        "cdots",
        "chi",
        "choose",
        "cos",
        "cup",
        "delta",
        "dfrac",
        "div",
        "dot",
        "dots",
        "ddot",
        "end",
        "epsilon",
        "equiv",
        "eta",
        "exists",
        "exp",
        "forall",
        "frac",
        "gamma",
        "ge",
        "geq",
        "hat",
        "in",
        "infty",
        "int",
        "iota",
        "kappa",
        "lambda",
        "land",
        "ldots",
        "le",
        "left",
        "leftarrow",
        "leftrightarrow",
        "leq",
        "lim",
        "ln",
        "log",
        "lor",
        "mapsto",
        "mathrm",
        "mathbf",
        "mathit",
        "matrix",
        "max",
        "min",
        "mod",
        "mp",
        "mu",
        "nabla",
        "neg",
        "neq",
        "notin",
        "nu",
        "omega",
        "operatorname",
        "overline",
        "phi",
        "pi",
        "pm",
        "pmatrix",
        "pmod",
        "prod",
        "psi",
        "qquad",
        "quad",
        "rho",
        "right",
        "rightarrow",
        "sigma",
        "sin",
        "sqrt",
        "subset",
        "subseteq",
        "sum",
        "supset",
        "supseteq",
        "tan",
        "tau",
        "text",
        "tfrac",
        "theta",
        "tilde",
        "times",
        "to",
        "underline",
        "upsilon",
        "varepsilon",
        "varphi",
        "varpi",
        "varrho",
        "varsigma",
        "vartheta",
        "vec",
        "xi",
        "zeta",
    }
)

# ---------------------------------------------------------------------------
# Regex constants (compiled once at import time)
# ---------------------------------------------------------------------------

_MARKDOWN_MATH_SPAN_RE = re.compile(r"(\$\$[\s\S]*?\$\$|\$(?!\$)(?:\\.|[^$])*\$)")
_BARE_LATEX_TRIGGER_RE = re.compile(r"\\[A-Za-z]+")
_BARE_LATEX_ENV_RE = re.compile(r"\\begin\{([A-Za-z*]+)\}[\s\S]*?\\end\{\1\}")


# ---------------------------------------------------------------------------
# JSON backslash repair for model-generated LaTeX
# ---------------------------------------------------------------------------


def _is_json_unicode_escape(value: str) -> bool:
    """Return True when *value* is exactly 4 hex digits (a valid \\u escape)."""
    return len(value) == 4 and all(char in "0123456789abcdefABCDEF" for char in value)


def _looks_like_latex_command(text: str, slash_index: int) -> bool:
    """Return True when the backslash at *slash_index* starts a recognised LaTeX command."""
    command_start = slash_index + 1
    command_end = command_start
    while command_end < len(text) and text[command_end].isalpha():
        command_end += 1
    if command_end == command_start:
        return False
    command = text[command_start:command_end]
    return command in _LATEX_COMMANDS_REQUIRING_JSON_ESCAPE


def repair_json_string_backslashes(text: str) -> str:
    """Add missing backslash escapes for LaTeX commands inside JSON strings.

    Walks through the raw text character by character, tracking whether the
    cursor is inside a JSON string.  When a bare ``\\`` followed by a known
    LaTeX command is found inside a string, it is doubled to ``\\\\`` so the
    JSON parser sees a literal backslash.
    """
    output: list[str] = []
    in_string = False
    index = 0
    while index < len(text):
        char = text[index]
        if not in_string:
            output.append(char)
            if char == '"':
                in_string = True
            index += 1
            continue

        if char == '"':
            output.append(char)
            in_string = False
            index += 1
            continue

        if char != "\\":
            output.append(char)
            index += 1
            continue

        if index + 1 >= len(text):
            output.append("\\\\")
            index += 1
            continue

        next_char = text[index + 1]
        if next_char in {'"', "\\", "/"}:
            output.append(text[index : index + 2])
            index += 2
            continue
        if next_char == "u" and _is_json_unicode_escape(text[index + 2 : index + 6]):
            output.append(text[index : index + 6])
            index += 6
            continue
        if _looks_like_latex_command(text, index):
            output.append("\\\\")
            index += 1
            continue
        if next_char in {"b", "f", "n", "r", "t"}:
            output.append(text[index : index + 2])
            index += 2
            continue

        output.append("\\\\")
        index += 1
    return "".join(output)


def json_loads_with_latex_repair(text: str) -> Any:
    """``json.loads`` with automatic repair of unescaped LaTeX backslashes.

    The repair runs *before* parsing — not only on ``JSONDecodeError`` —
    because many LaTeX commands (``\\text``, ``\\times``, ``\\frac``,
    ``\\theta``, ``\\tau``, ``\\nabla``, …) are syntactically valid JSON
    escapes and would be silently corrupted by ``json.loads`` alone.
    """
    return json.loads(repair_json_string_backslashes(text))


# ---------------------------------------------------------------------------
# Markdown math normalisation
# ---------------------------------------------------------------------------


def normalize_markdown_math(value: str) -> str:
    """Repair common Markdown/LaTeX issues in model-generated text.

    Code-fence blocks (```...```) are left untouched.
    """
    if not value:
        return value
    segments = re.split(r"(```[\s\S]*?```)", value)
    return "".join(
        segment if segment.startswith("```") else _normalize_markdown_math_segment(segment)
        for segment in segments
    )


def _normalize_markdown_math_segment(value: str) -> str:
    value = _normalize_escaped_markdown_newlines(value)
    value = _repair_binary_transition_math_spillover(value)
    value = _wrap_bare_latex_math(value)
    return re.sub(
        r"(\$\$[\s\S]*?\$\$|\$(?!\$)(?:\\.|[^$])*\$)",
        _normalize_math_match,
        value,
    )


def _normalize_escaped_markdown_newlines(value: str) -> str:
    """Convert literal ``\\n`` that precedes Markdown list/heading syntax into real newlines."""
    return re.sub(
        r"\\n(?=(?:[ \t]*(?:[-*+]\s|\d+[.)]\s|#{1,6}\s)|\s*$))",
        "\n",
        value,
    )


def _repair_binary_transition_math_spillover(value: str) -> str:
    """Fix binary counting sequences where Chinese punctuation leaked inside ``$...$``."""
    return re.sub(
        r"\$((?:[01]{2,}|\\cdots)(?:\s*(?:\\to|\\rightarrow|→)\s*(?:[01]{2,}|\\cdots))+)(\s*)([。；，、](?=[㐀-鿿]))",
        lambda match: f"${match.group(1)}${match.group(2)}{match.group(3)}",
        value,
    )


# ---------------------------------------------------------------------------
# Bare LaTeX → $...$ / $$...$$ wrapping
# ---------------------------------------------------------------------------


def _wrap_bare_latex_math(value: str) -> str:
    parts = _MARKDOWN_MATH_SPAN_RE.split(value)
    return "".join(
        part if part.startswith("$") else _wrap_bare_latex_math_text(part) for part in parts
    )


def _wrap_bare_latex_math_text(value: str) -> str:
    value = _BARE_LATEX_ENV_RE.sub(
        lambda match: f"\n\n$$\n{match.group(0).strip()}\n$$\n\n",
        value,
    )
    parts = _MARKDOWN_MATH_SPAN_RE.split(value)
    return "".join(
        part if part.startswith("$") else _wrap_bare_latex_inline_math_text(part)
        for part in parts
    )


def _wrap_bare_latex_inline_math_text(value: str) -> str:
    output: list[str] = []
    index = 0
    while index < len(value):
        match = _BARE_LATEX_TRIGGER_RE.search(value, index)
        if not match:
            output.append(value[index:])
            break
        slash_index = match.start()
        command = match.group(0)[1:]
        if command not in _LATEX_COMMANDS_REQUIRING_JSON_ESCAPE:
            output.append(value[index : match.end()])
            index = match.end()
            continue
        expression_start = _bare_latex_expression_start(value, slash_index)
        expression_end = _bare_latex_expression_end(value, slash_index)
        if expression_end <= slash_index:
            output.append(value[index : match.end()])
            index = match.end()
            continue
        output.append(value[index:expression_start])
        expression = value[expression_start:expression_end].strip()
        delimiter = "$$" if "\n" in expression else "$"
        output.append(f"{delimiter}{_normalize_katex_body(expression)}{delimiter}")
        index = expression_end
    return "".join(output)


def _bare_latex_expression_start(value: str, slash_index: int) -> int:
    cursor = slash_index - 1
    while cursor >= 0 and value[cursor] in " \t":
        cursor -= 1
    if cursor < 0 or value[cursor] not in "=+-*/(^_":
        return slash_index
    start = cursor
    while start > 0 and value[start - 1] not in "\n\r，。；：！？、":
        if value[start - 1] in "$`":
            break
        start -= 1
    return start


def _bare_latex_expression_end(value: str, slash_index: int) -> int:
    cursor = slash_index
    while cursor < len(value):
        token_end = _consume_latex_math_token(value, cursor)
        if token_end <= cursor:
            break
        cursor = token_end
        space_start = cursor
        while cursor < len(value) and value[cursor] in " \t":
            cursor += 1
        if not _starts_latex_math_continuation(value, cursor):
            cursor = space_start
            break
    while cursor > slash_index and value[cursor - 1] in " \t.,;:":
        cursor -= 1
    return cursor


def _starts_latex_math_continuation(value: str, index: int) -> bool:
    if index >= len(value):
        return False
    if value[index] == "\\":
        command_match = _BARE_LATEX_TRIGGER_RE.match(value, index)
        return bool(
            command_match and command_match.group(0)[1:] in _LATEX_COMMANDS_REQUIRING_JSON_ESCAPE
        )
    return value[index] in "{}()+-*/=^_[]<>|,." or value[index].isdigit()


def _consume_latex_math_token(value: str, index: int) -> int:
    if index >= len(value) or value[index] in "\n\r，。；：！？、$`":
        return index
    if value[index] == "\\":
        command_match = _BARE_LATEX_TRIGGER_RE.match(value, index)
        if (
            not command_match
            or command_match.group(0)[1:] not in _LATEX_COMMANDS_REQUIRING_JSON_ESCAPE
        ):
            return index
        cursor = command_match.end()
        if command_match.group(0)[1:] in {"left", "right"}:
            while cursor < len(value) and value[cursor] in " \t":
                cursor += 1
            if cursor < len(value) and value[cursor] not in "\n\r":
                cursor += 1
        while True:
            group_end = _consume_braced_group(value, cursor)
            if group_end <= cursor:
                break
            cursor = group_end
        return cursor
    if value[index] == "{":
        return _consume_braced_group(value, index)
    if value[index].isdigit():
        cursor = index + 1
        while cursor < len(value) and re.match(r"[0-9.eE+-]", value[cursor]):
            cursor += 1
        return cursor
    if value[index] in "()+-*/=^_[]<>|,.":
        return index + 1
    return index


def _consume_braced_group(value: str, index: int) -> int:
    if index >= len(value) or value[index] != "{":
        return index
    depth = 0
    cursor = index
    while cursor < len(value):
        char = value[cursor]
        if char == "\\":
            cursor += 2
            continue
        if char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return cursor + 1
        cursor += 1
    return index


def _normalize_math_match(match: re.Match[str]) -> str:
    segment = match.group(0)
    delimiter = "$$" if segment.startswith("$$") else "$"
    if not segment.endswith(delimiter):
        return segment
    body = segment[len(delimiter) : -len(delimiter)]
    return f"{delimiter}{_normalize_katex_body(body)}{delimiter}"


def _normalize_katex_body(value: str) -> str:
    normalized = _normalize_math_vertical_bars(re.sub(r"\\(?=\d)", "", value))
    if not re.search(r"\\(?:text|mathrm|operatorname)\s*\{", normalized):
        normalized = re.sub(
            r"([㐀-鿿，。、；：！？、]+)", r"\\text{\1}", normalized
        )
    return normalized


def _normalize_math_vertical_bars(value: str) -> str:
    positions = [
        index
        for index, char in enumerate(value)
        if char == "|" and not _is_escaped_at(value, index)
    ]
    if not positions:
        return value
    paired = len(positions) % 2 == 0
    output: list[str] = []
    bar_index = 0
    for index, char in enumerate(value):
        if char == "|" and not _is_escaped_at(value, index):
            if paired:
                output.append(r"\lvert{}" if bar_index % 2 == 0 else r"\rvert{}")
            else:
                output.append(r"\vert{}")
            bar_index += 1
        else:
            output.append(char)
    return "".join(output)


def _is_escaped_at(value: str, index: int) -> bool:
    slash_count = 0
    cursor = index - 1
    while cursor >= 0 and value[cursor] == "\\":
        slash_count += 1
        cursor -= 1
    return slash_count % 2 == 1
