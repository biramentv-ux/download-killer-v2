from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

SOURCE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = SOURCE_ROOT.parents[1]
OUTPUT = REPO_ROOT / "worker" / "public" / "downloads" / "DyrakArmy-Extension-Chrome.zip"

INCLUDE = [
    "manifest.json",
    "background.js",
    "content.js",
    "popup.html",
    "popup.js",
    "styles.css",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
    "utils/api.js",
    "utils/metadata.js",
    "utils/storage.js",
    "utils/validators.js",
]

FORBIDDEN_CODE_MARKERS = [
    "re-unplayplay",
    "PlayPlay DRM",
    "Widevine CDM",
    "obfuscatedKey",
    "window.fetch =",
    "XMLHttpRequest.prototype.open =",
    "audio-files",
]


def validate() -> None:
    manifest = json.loads((SOURCE_ROOT / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("manifest_version") != 3:
        raise SystemExit("Manifest V3 is required")

    permissions = set(manifest.get("permissions", []))
    forbidden_permissions = {"webRequest", "webRequestBlocking"}
    overlap = sorted(permissions & forbidden_permissions)
    if overlap:
        raise SystemExit(f"Forbidden permissions: {', '.join(overlap)}")

    for relative in INCLUDE:
        path = SOURCE_ROOT / relative
        if not path.is_file():
            raise SystemExit(f"Missing release file: {relative}")
        if path.suffix in {".js", ".html", ".css", ".json"}:
            text = path.read_text(encoding="utf-8")
            for marker in FORBIDDEN_CODE_MARKERS:
                if marker in text:
                    raise SystemExit(f"Forbidden implementation marker in {relative}: {marker}")


def build() -> str:
    validate()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT.with_suffix(".zip.tmp")
    temporary.unlink(missing_ok=True)

    with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED) as archive:
        for relative in INCLUDE:
            archive.write(SOURCE_ROOT / relative, relative)

    temporary.replace(OUTPUT)
    digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
    print(f"Built {OUTPUT}")
    print(f"SHA-256 {digest}")
    return digest


if __name__ == "__main__":
    build()
