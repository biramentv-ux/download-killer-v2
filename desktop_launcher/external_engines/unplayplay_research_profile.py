from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path
from typing import Final


PROFILE_PATH: Final = (
    Path(__file__).resolve().parents[2]
    / "worker"
    / "public"
    / "platform"
    / "playplay-demo"
    / "unplayplay-profile.json"
)
ALLOWED_METADATA_FILES: Final = (
    ".gitignore",
    "binding.gyp",
    "LICENSE",
    "package.json",
    "pnpm-lock.yaml",
    "README.md",
    "tsconfig.json",
)
REQUIRED_DISABLED_CAPABILITIES: Final = (
    "native_addon_build",
    "native_addon_loading",
    "subprocess_execution",
    "network_access",
    "credential_access",
    "key_deobfuscation",
    "drm_decryption",
)
SHA256_RE: Final = re.compile(r"^[0-9a-f]{64}$")


def load_profile(path: Path = PROFILE_PATH) -> dict[str, object]:
    profile = json.loads(Path(path).read_text(encoding="utf-8"))
    validate_profile(profile)
    return profile


def validate_profile(profile: dict[str, object]) -> bool:
    """Validate the metadata-only contract without importing or executing upstream code."""
    if profile.get("schema_version") != 1:
        raise ValueError("Unsupported unplayplay research profile schema.")
    if profile.get("integration_id") != "unplayplay-metadata-profile":
        raise ValueError("Unexpected unplayplay integration identifier.")
    if profile.get("mode") != "metadata-only":
        raise ValueError("The unplayplay profile must remain metadata-only.")
    if profile.get("source_code_bundled") is not False:
        raise ValueError("Upstream source code must not be bundled.")
    if profile.get("package_scripts_executed") is not False:
        raise ValueError("Package install scripts must not be executed.")
    if profile.get("runtime_imported_files") != []:
        raise ValueError("Runtime imports are forbidden for this profile.")

    capabilities = profile.get("runtime_capabilities")
    if not isinstance(capabilities, dict):
        raise ValueError("runtime_capabilities must be an object.")
    if set(capabilities) != set(REQUIRED_DISABLED_CAPABILITIES):
        raise ValueError("Runtime capability keys do not match the safe profile.")
    if any(capabilities[name] is not False for name in REQUIRED_DISABLED_CAPABILITIES):
        raise ValueError("Every runtime capability must remain disabled.")

    provided = profile.get("provided_files")
    if not isinstance(provided, list):
        raise ValueError("provided_files must be a list.")
    paths: list[str] = []
    for entry in provided:
        if not isinstance(entry, dict):
            raise ValueError("Every provided file entry must be an object.")
        path = str(entry.get("path", ""))
        digest = str(entry.get("sha256", ""))
        size = entry.get("bytes")
        if path not in ALLOWED_METADATA_FILES:
            raise ValueError(f"Unexpected file in metadata profile: {path}")
        if not SHA256_RE.fullmatch(digest):
            raise ValueError(f"Invalid SHA-256 for {path}")
        if not isinstance(size, int) or size < 0:
            raise ValueError(f"Invalid byte size for {path}")
        paths.append(path)
    if tuple(paths) != ALLOWED_METADATA_FILES:
        raise ValueError("The metadata file inventory is incomplete or out of order.")
    return True


def verify_source_snapshot(source: Path, profile: dict[str, object] | None = None) -> dict[str, object]:
    """Hash only the seven supplied root metadata files; never load native or source code."""
    root = Path(source).expanduser().resolve()
    validated = profile or load_profile()
    validate_profile(validated)
    expected_entries = {
        str(entry["path"]): entry
        for entry in validated["provided_files"]
        if isinstance(entry, dict)
    }
    results: list[dict[str, object]] = []
    for relative in ALLOWED_METADATA_FILES:
        path = root / relative
        expected = expected_entries[relative]
        if not path.is_file():
            results.append({"path": relative, "match": False, "reason": "missing"})
            continue
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        size = path.stat().st_size
        results.append(
            {
                "path": relative,
                "match": digest == expected["sha256"] and size == expected["bytes"],
                "sha256": digest,
                "bytes": size,
            }
        )
    return {
        "integration_id": validated["integration_id"],
        "mode": "metadata-only-verification",
        "source": str(root),
        "matched": all(bool(entry["match"]) for entry in results),
        "files": results,
        "runtime_capabilities": dict(validated["runtime_capabilities"]),
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Validate the metadata-only unplayplay research profile."
    )
    parser.add_argument(
        "--source",
        type=Path,
        help="Optional local upstream folder whose seven supplied root files will be hashed.",
    )
    args = parser.parse_args()
    profile = load_profile()
    result = verify_source_snapshot(args.source, profile) if args.source else profile
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if not args.source or bool(result["matched"]) else 1


if __name__ == "__main__":
    raise SystemExit(main())
