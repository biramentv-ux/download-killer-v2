from __future__ import annotations

import argparse
import json
import re
from pathlib import Path, PureWindowsPath
from typing import Final

APP_VERSION: Final = "0.1.0"
DEMO_ROOT: Final = PureWindowsPath("C:/playplay-demo")
SUPPORTED_QUALITIES: Final = (96, 160, 320)
SPOTIFY_REFERENCE_RE: Final = re.compile(
    r"^(?:https?://open\.spotify\.com/(?:intl-[a-z]{2}/)?"
    r"(?:track|album|playlist|show|episode)/[A-Za-z0-9]+(?:\?.*)?"
    r"|spotify:(?:track|album|playlist|show|episode):[A-Za-z0-9]+)$",
    re.IGNORECASE,
)

CAPABILITIES: Final[dict[str, bool]] = {
    "network_access": False,
    "subprocess_execution": False,
    "credential_storage": False,
    "cookie_loading": False,
    "wvd_loading": False,
    "key_loading": False,
    "drm_decryption": False,
}


def validate_spotify_reference(value: str) -> str:
    normalized = str(value or "").strip()
    if not SPOTIFY_REFERENCE_RE.fullmatch(normalized):
        raise ValueError("A public Spotify URL or URI is required for the demo preview.")
    return normalized


def normalize_quality(value: int | str) -> int:
    try:
        quality = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Demo quality must be 96, 160, or 320 kbps.") from exc
    if quality not in SUPPORTED_QUALITIES:
        raise ValueError("Demo quality must be 96, 160, or 320 kbps.")
    return quality


def build_demo_payload(spotify_reference: str, quality: int | str = 320) -> dict[str, object]:
    """Build a non-executable PlayPlay-shaped preview for documentation and UI tests."""
    reference = validate_spotify_reference(spotify_reference)
    normalized_quality = normalize_quality(quality)

    demo_exe = str(DEMO_ROOT / "playplay-DEMO-ONLY.exe")
    demo_config = str(DEMO_ROOT / "config.demo.json")
    config_preview = {
        "cookies_path": str(DEMO_ROOT / "DEMO_COOKIES_NOT_REAL.txt"),
        "wvd_path": str(DEMO_ROOT / "DEMO_DEVICE_NOT_REAL.wvd"),
        "output_dir": str(DEMO_ROOT / "output-DEMO-ONLY"),
        "quality": normalized_quality,
    }

    return {
        "demo_only": True,
        "adapter": "playplay-safe-preview",
        "version": APP_VERSION,
        "input": {
            "spotify_reference": reference,
            "quality_kbps": normalized_quality,
        },
        "config_preview": config_preview,
        "command_preview": [
            demo_exe,
            "--config",
            demo_config,
            "--url",
            reference,
        ],
        "capabilities": dict(CAPABILITIES),
        "notice": (
            "Preview only. The adapter never launches an executable, reads cookies, "
            "loads a WVD/CDM profile, contacts Spotify, or decrypts media."
        ),
    }


def validate_demo_payload(payload: dict[str, object]) -> bool:
    if payload.get("demo_only") is not True:
        return False
    if payload.get("adapter") != "playplay-safe-preview":
        return False

    capabilities = payload.get("capabilities")
    if capabilities != CAPABILITIES:
        return False

    config = payload.get("config_preview")
    if not isinstance(config, dict):
        return False

    protected_values = (
        str(config.get("cookies_path", "")),
        str(config.get("wvd_path", "")),
        str(config.get("output_dir", "")),
    )
    if not all("DEMO" in value.upper() for value in protected_values):
        return False

    command = payload.get("command_preview")
    if not isinstance(command, list) or not command:
        return False
    if "DEMO" not in str(command[0]).upper():
        return False

    return True


def save_demo_payload(target: Path, payload: dict[str, object]) -> Path:
    """Save only validated demo JSON with an explicit .demo.json suffix."""
    path = Path(target).expanduser().resolve()
    if not path.name.lower().endswith(".demo.json"):
        raise ValueError("Demo exports must use the .demo.json suffix.")
    if not validate_demo_payload(payload):
        raise ValueError("The payload is not a safe PlayPlay demo preview.")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate a non-functional PlayPlay demo preview.")
    parser.add_argument("--url", required=True, help="Public Spotify URL or URI")
    parser.add_argument("--quality", default=320, choices=SUPPORTED_QUALITIES, type=int)
    parser.add_argument("--output", type=Path, help="Optional *.demo.json output file")
    args = parser.parse_args()

    payload = build_demo_payload(args.url, args.quality)
    if args.output:
        saved = save_demo_payload(args.output, payload)
        print(saved)
    else:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
