"""The audit contracts are load-bearing, so they are tested, not just shipped.

This module carries a deliberately small JSON Schema subset validator
(type/const/enum/pattern/required/properties/additionalProperties/items/
minItems/minimum — no $ref, no $defs, no conditionals). The audit schemas
are written against exactly this subset so that flowaudit can validate
evidence records with the standard library alone, and so that this test
can enforce conformance of every committed example at CI time.

The tamper cases below are the interesting part: an example that stops
conforming after a plausible edit proves the schema actually bites.
"""

from __future__ import annotations

import json
import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCHEMA_DIR = ROOT / "audit-rules" / "schema"
EXAMPLE_DIR = SCHEMA_DIR / "examples"


def validate(instance, schema: dict, path: str = "$") -> list[str]:
    """Validate one instance against the supported keyword subset.

    Returns a list of violation paths (empty means conforming). This is
    not a general JSON Schema implementation and does not pretend to be:
    if a schema starts needing keywords beyond the subset, that is a
    signal to grow the validator deliberately, with tests.
    """
    errors: list[str] = []
    kind = schema.get("type")
    if kind == "object":
        if not isinstance(instance, dict):
            return [f"{path}: expected object, got {type(instance).__name__}"]
    elif kind == "string":
        if not isinstance(instance, str):
            return [f"{path}: expected string"]
    elif kind == "boolean":
        if not isinstance(instance, bool):
            return [f"{path}: expected boolean"]
    elif kind == "integer":
        if not isinstance(instance, int) or isinstance(instance, bool):
            return [f"{path}: expected integer"]
    elif kind == "array":
        if not isinstance(instance, list):
            return [f"{path}: expected array"]

    if "const" in schema and instance != schema["const"]:
        errors.append(f"{path}: expected const {schema['const']!r}")
    if "enum" in schema and instance not in schema["enum"]:
        errors.append(f"{path}: {instance!r} not in enum")
    if "pattern" in schema and isinstance(instance, str):
        if not re.search(schema["pattern"], instance):
            errors.append(f"{path}: {instance!r} fails pattern {schema['pattern']!r}")
    if "minimum" in schema and isinstance(instance, (int, float)) \
            and not isinstance(instance, bool):
        if instance < schema["minimum"]:
            errors.append(f"{path}: {instance} below minimum {schema['minimum']}")

    if isinstance(instance, dict):
        for key in schema.get("required", []):
            if key not in instance:
                errors.append(f"{path}: missing required property {key!r}")
        properties = schema.get("properties", {})
        if schema.get("additionalProperties") is False:
            for key in instance:
                if key not in properties:
                    errors.append(f"{path}: unexpected property {key!r}")
        for key, value in instance.items():
            if key in properties:
                errors.extend(validate(value, properties[key], f"{path}.{key}"))

    if isinstance(instance, list):
        if "minItems" in schema and len(instance) < schema["minItems"]:
            errors.append(f"{path}: fewer than {schema['minItems']} items")
        if "items" in schema:
            for index, item in enumerate(instance):
                errors.extend(validate(item, schema["items"], f"{path}[{index}]"))
    return errors


class SchemaIntegrityTests(unittest.TestCase):
    def test_schemas_parse_and_declare_subset(self) -> None:
        for name in ("poc-evidence.schema.json", "audit-bundle.schema.json"):
            schema = json.loads((SCHEMA_DIR / name).read_text(encoding="utf-8"))
            self.assertEqual(schema["$schema"], "https://json-schema.org/draft/2020-12/schema")
            self.assertEqual(schema["type"], "object")
            self.assertTrue(schema.get("additionalProperties") is False,
                            f"{name} must reject unknown properties")

    def test_committed_examples_conform(self) -> None:
        schema = json.loads((SCHEMA_DIR / "poc-evidence.schema.json").read_text(encoding="utf-8"))
        for name in ("poc-evidence-fcode02.json", "poc-evidence-negative-control.json"):
            record = json.loads((EXAMPLE_DIR / name).read_text(encoding="utf-8"))
            self.assertEqual(validate(record, schema), [],
                             f"{name} must conform to the poc-evidence contract")

    def test_outcome_vocabulary_matches_the_state_machine(self) -> None:
        schema = json.loads((SCHEMA_DIR / "poc-evidence.schema.json").read_text(encoding="utf-8"))
        outcomes = schema["properties"]["replay"]["properties"]["outcome"]["enum"]
        self.assertEqual(
            outcomes,
            ["finding", "not_reproduced", "invalid_poc", "not_vulnerable_under_scope"],
            "the four-valued replay outcome is frozen by the 2026-10-31 review",
        )
        # A FAIL is not an absence: the vocabulary must not contain a bare
        # "dismissed"-style value that would conflate not-reproduced with safe.
        self.assertNotIn("dismissed", outcomes)


class TamperDetectionTests(unittest.TestCase):
    """Each case edits a committed example the way a hostile or sloppy
    writer would, and the schema must refuse it."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.schema = json.loads(
            (SCHEMA_DIR / "poc-evidence.schema.json").read_text(encoding="utf-8"))
        cls.example = json.loads(
            (EXAMPLE_DIR / "poc-evidence-fcode02.json").read_text(encoding="utf-8"))

    def _edited(self, **changes) -> dict:
        record = json.loads(json.dumps(self.example))
        for key, value in changes.items():
            if value is None:
                record.pop(key, None)
            else:
                record[key] = value
        return record

    def test_self_declared_pass_is_rejected_by_vocabulary(self) -> None:
        # A hostile PoC renames its outcome; the enum refuses invented values.
        errors = validate(self._edited(replay={
            "outcome": "pass_because_i_said_so", "runs": {"passed": 3, "total": 3}}),
            self.schema)
        self.assertTrue(any("replay.outcome" in e for e in errors))

    def test_missing_oracle_executor_is_rejected(self) -> None:
        record = self._edited()
        record["oracle"].pop("executor")
        errors = validate(record, self.schema)
        self.assertTrue(any("oracle" in e and "executor" in e for e in errors),
                        "the oracle must be pinned to the host")

    def test_non_host_oracle_is_rejected(self) -> None:
        record = self._edited()
        record["oracle"]["executor"] = "poc"
        errors = validate(record, self.schema)
        self.assertTrue(any("oracle.executor" in e for e in errors))

    def test_unknown_property_is_rejected(self) -> None:
        errors = validate(self._edited(shortcut="trust me"), self.schema)
        self.assertTrue(any("shortcut" in e for e in errors))

    def test_missing_target_pin_is_rejected(self) -> None:
        errors = validate(self._edited(target_ref=None), self.schema)
        self.assertTrue(any("target_ref" in e for e in errors))

    def test_bad_manifest_hash_is_rejected(self) -> None:
        record = self._edited()
        record["target_ref"]["manifest_sha256"] = "not-a-hash"
        errors = validate(record, self.schema)
        self.assertTrue(any("manifest_sha256" in e for e in errors))

    def test_real_credentials_flag_cannot_be_tampered(self) -> None:
        record = self._edited()
        record["replay_environment"]["no_real_credentials"] = False
        errors = validate(record, self.schema)
        self.assertTrue(any("no_real_credentials" in e for e in errors),
                        "the constrained replay environment is not negotiable")

    def test_zero_runs_is_rejected(self) -> None:
        record = self._edited()
        record["replay"]["runs"] = {"passed": 0, "total": 0}
        errors = validate(record, self.schema)
        self.assertTrue(any("replay.runs.total" in e for e in errors))


if __name__ == "__main__":
    unittest.main()
