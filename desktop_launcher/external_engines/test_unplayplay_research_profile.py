from __future__ import annotations

import copy
import tempfile
import unittest
from pathlib import Path

from external_engines.unplayplay_research_profile import (
    ALLOWED_METADATA_FILES,
    PROFILE_PATH,
    load_profile,
    validate_profile,
    verify_source_snapshot,
)


class UnplayplayResearchProfileTests(unittest.TestCase):
    def test_bundled_profile_is_metadata_only(self) -> None:
        profile = load_profile(PROFILE_PATH)
        self.assertTrue(validate_profile(profile))
        self.assertFalse(profile["source_code_bundled"])
        self.assertFalse(profile["package_scripts_executed"])
        self.assertEqual(profile["runtime_imported_files"], [])
        self.assertTrue(all(value is False for value in profile["runtime_capabilities"].values()))

    def test_profile_contains_only_the_supplied_root_files(self) -> None:
        profile = load_profile(PROFILE_PATH)
        self.assertEqual(
            tuple(entry["path"] for entry in profile["provided_files"]),
            ALLOWED_METADATA_FILES,
        )

    def test_rejects_enabled_key_or_native_capability(self) -> None:
        profile = copy.deepcopy(load_profile(PROFILE_PATH))
        profile["runtime_capabilities"]["key_deobfuscation"] = True
        with self.assertRaises(ValueError):
            validate_profile(profile)

        profile = copy.deepcopy(load_profile(PROFILE_PATH))
        profile["runtime_capabilities"]["native_addon_loading"] = True
        with self.assertRaises(ValueError):
            validate_profile(profile)

    def test_rejects_runtime_imports(self) -> None:
        profile = copy.deepcopy(load_profile(PROFILE_PATH))
        profile["runtime_imported_files"] = ["binding.gyp"]
        with self.assertRaises(ValueError):
            validate_profile(profile)

    def test_snapshot_verifier_hashes_only_allowlisted_metadata(self) -> None:
        profile = load_profile(PROFILE_PATH)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for entry in profile["provided_files"]:
                (root / entry["path"]).write_bytes(b"not-the-recorded-file")
            (root / "src").mkdir()
            (root / "src" / "main.cc").write_text("must not be read", encoding="utf-8")

            result = verify_source_snapshot(root, profile)
            self.assertFalse(result["matched"])
            self.assertEqual(tuple(row["path"] for row in result["files"]), ALLOWED_METADATA_FILES)
            self.assertNotIn("src/main.cc", {row["path"] for row in result["files"]})


if __name__ == "__main__":
    unittest.main()
