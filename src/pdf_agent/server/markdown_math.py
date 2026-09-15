r"""JSON repair for model output that carries LaTeX.

Models routinely write ``\frac`` inside a JSON string where JSON needs
``\\frac``; these helpers make such output parseable without touching the
Markdown itself. Math delimiters are not normalised here: the web app's
markdown tokenizer recognises ``$...$``, ``$$...$$``, ``\(...\)`` and
``\[...\]`` directly, and a stored page is rendered exactly as the model
wrote it.

All functions are pure and stateless — safe to import anywhere.
"""

from __future__ import annotations

import json
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
        if next_char.isdigit():
            # ``\2^n`` or ``\000``: not a JSON escape and not LaTeX either; the
            # backslash is noise from the model.
            index += 1
            continue

        output.append("\\\\")
        index += 1
    return "".join(output)


def repair_json_escape_artifacts(text: str) -> str:
    """Undo two artifacts of a model escaping backslashes inside JSON strings.

    - A literal backslash followed by ``n`` and then anything but an ASCII letter is a newline
      the model escaped twice (``\\\\n``): it becomes a line break. ``\\nabla``,
      ``\\neq`` and ``\\nu`` keep their backslash.
    - A backslash before a digit (``\\2^n``, ``\\000``) means nothing in LaTeX
      or Markdown and is dropped.

    Nothing else is touched: delimiters and formulas are stored as written.
    """
    if "\\" not in text:
        return text
    output: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char == "\\":
            following = text[index + 1 : index + 2]
            after = text[index + 2 : index + 3]
            if following == "n" and not (after.isascii() and after.isalpha()):
                output.append("\n")
                index += 2
                continue
            if following.isdigit():
                index += 1
                continue
        output.append(char)
        index += 1
    return "".join(output)


_JSON_OPENERS = "{[:,"
_JSON_CLOSERS = ",:}]"


def repair_json_prose_quotes(text: str) -> str:
    """Turn straight double quotes used *inside* prose into curly quotes.

    Models writing Chinese prose sometimes quote a phrase with ASCII ``"``
    (``常考"单点梯度"的简答``), which terminates the JSON string early.  A
    quote is kept as JSON syntax when the previous non-blank character opens
    a value (``{ [ : ,``) or the next one closes it (``, : } ]``); every other
    unescaped quote is inside prose and becomes ``“`` / ``”`` alternately.
    Valid JSON passes through unchanged.
    """
    output: list[str] = []
    length = len(text)
    prose_open = False
    for index, char in enumerate(text):
        if char != '"' or (index > 0 and text[index - 1] == "\\"):
            output.append(char)
            continue
        previous = index - 1
        while previous >= 0 and text[previous] in " \t\r\n":
            previous -= 1
        following = index + 1
        while following < length and text[following] in " \t\r\n":
            following += 1
        prev_char = text[previous] if previous >= 0 else ""
        next_char = text[following] if following < length else ""
        if not prose_open and (prev_char in _JSON_OPENERS or not prev_char or next_char in _JSON_CLOSERS or not next_char):
            output.append(char)
            continue
        output.append("\u201d" if prose_open else "\u201c")
        prose_open = not prose_open
    return "".join(output)


def json_loads_with_latex_repair(text: str) -> Any:
    """``json.loads`` with automatic repair of unescaped LaTeX backslashes.

    The backslash repair runs *before* parsing — not only on
    ``JSONDecodeError`` — because many LaTeX commands (``\\text``,
    ``\\times``, ``\\frac``, ``\\theta``, ``\\tau``, ``\\nabla``, …) are
    syntactically valid JSON escapes and would be silently corrupted by
    ``json.loads`` alone.  Straight quotes inside prose are repaired only when
    the first parse fails, since valid JSON never needs that pass.
    """
    repaired = repair_json_string_backslashes(text)
    try:
        return json.loads(repaired)
    except json.JSONDecodeError:
        return json.loads(repair_json_string_backslashes(repair_json_prose_quotes(text)))
