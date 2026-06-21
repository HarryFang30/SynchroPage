from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator


ROOT = Path(__file__).resolve().parents[1]
SCHEMA_PATHS = {
    "lecture_pairpack.v1": ROOT / "contracts/schemas/lecture_pairpack/v1.schema.json",
    "lecture_pairpack.page_batch.v1": ROOT / "contracts/schemas/lecture_pairpack/page_batch.v1.schema.json",
}


def main() -> int:
    yaml_paths = sorted(ROOT.joinpath("config").rglob("*.yaml"))
    for path in yaml_paths:
        yaml.safe_load(path.read_text(encoding="utf-8"))

    json_paths = sorted(
        path
        for base in (ROOT / "contracts", ROOT / "examples")
        for path in base.rglob("*.json")
    )
    json_documents = {path: _load_json(path) for path in json_paths}

    schemas = {name: json_documents[path] for name, path in SCHEMA_PATHS.items()}
    for schema in schemas.values():
        Draft202012Validator.check_schema(schema)

    validated_examples = 0
    for path, document in json_documents.items():
        schema_name = document.get("schema") if isinstance(document, dict) else None
        if schema_name not in schemas:
            continue
        Draft202012Validator(schemas[str(schema_name)]).validate(document)
        validated_examples += 1

    if validated_examples < len(SCHEMA_PATHS):
        raise SystemExit("No example JSON document was validated for every lecture_pairpack schema")

    print(
        "validated "
        f"{len(yaml_paths)} YAML files, "
        f"{len(json_paths)} JSON files, "
        f"{len(schemas)} schemas, "
        f"{validated_examples} schema examples"
    )
    return 0


def _load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise SystemExit(f"Invalid JSON in {path.relative_to(ROOT)}: {exc}") from exc


if __name__ == "__main__":
    raise SystemExit(main())
