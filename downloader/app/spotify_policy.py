from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any


SUPPORTED_SPOTIFY_KINDS = {
    "track",
    "album",
    "playlist",
    "artist",
    "show",
    "episode",
}

_SPOTIFY_URI_RE = re.compile(
    r"^spotify:(track|album|playlist|artist|show|episode):([A-Za-z0-9]+)$",
    re.IGNORECASE,
)
_SPOTIFY_URL_RE = re.compile(
    r"^https?://open\.spotify\.com/(track|album|playlist|artist|show|episode)/([A-Za-z0-9]+)",
    re.IGNORECASE,
)

# These fields belong to protected-stream key extraction/decryption workflows.
# SoundDrop accepts public content references and metadata only.
_FORBIDDEN_KEY_NAMES = {
    "aeskey",
    "decryptionkey",
    "contentkey",
    "fileid",
    "cdm",
    "cdmdata",
    "devicewvd",
    "widevine",
    "widevinelicense",
    "licensechallenge",
    "licenseresponse",
    "pssh",
    "playplaykey",
    "spotifyaudiostream",
    "encryptedstream",
}

_FORBIDDEN_STRING_PATTERNS = (
    re.compile(r"\bwidevine-license\b", re.IGNORECASE),
    re.compile(r"\bspotify[_ -]?audio[_ -]?stream\b", re.IGNORECASE),
    re.compile(r"\bplayplay[_ -]?key\b", re.IGNORECASE),
    re.compile(r"\b(?:aes|decryption)[_ -]?key\s*[:=]", re.IGNORECASE),
    re.compile(r"\bpssh\s*[:=]", re.IGNORECASE),
)


def _normalized_key(value: object) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


def normalize_spotify_reference(value: str) -> str:
    """Convert a supported Spotify URI to its canonical public web URL.

    Existing open.spotify.com URLs are canonicalized by removing query strings
    and fragments. Other HTTP(S) URLs are returned unchanged.
    """

    candidate = str(value or "").strip()
    if not candidate:
        return candidate

    uri_match = _SPOTIFY_URI_RE.fullmatch(candidate)
    if uri_match:
        kind, spotify_id = uri_match.groups()
        return f"https://open.spotify.com/{kind.lower()}/{spotify_id}"

    url_match = _SPOTIFY_URL_RE.match(candidate)
    if url_match:
        kind, spotify_id = url_match.groups()
        return f"https://open.spotify.com/{kind.lower()}/{spotify_id}"

    return candidate


def collect_forbidden_paths(value: Any, path: str = "$") -> list[str]:
    """Return JSON-style paths containing protected-stream material."""

    findings: list[str] = []

    if isinstance(value, Mapping):
        for raw_key, child in value.items():
            key = str(raw_key)
            child_path = f"{path}.{key}"
            if _normalized_key(key) in _FORBIDDEN_KEY_NAMES:
                findings.append(child_path)
            findings.extend(collect_forbidden_paths(child, child_path))
        return findings

    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for index, child in enumerate(value):
            findings.extend(collect_forbidden_paths(child, f"{path}[{index}]"))
        return findings

    if isinstance(value, str):
        for pattern in _FORBIDDEN_STRING_PATTERNS:
            if pattern.search(value):
                findings.append(path)
                break

    return findings


def sanitize_download_payload(payload: Any) -> Any:
    """Validate a JSON payload and normalize its public Spotify URL.

    The function returns a shallow copy for mappings so callers can safely
    serialize the sanitized result without mutating the original object.
    """

    forbidden_paths = collect_forbidden_paths(payload)
    if forbidden_paths:
        preview = ", ".join(forbidden_paths[:5])
        suffix = "" if len(forbidden_paths) <= 5 else f" (+{len(forbidden_paths) - 5} more)"
        raise ValueError(
            "Protected-stream keys, CDM/Widevine data, File IDs and encrypted "
            f"Spotify streams are not accepted: {preview}{suffix}",
        )

    if not isinstance(payload, Mapping):
        return payload

    sanitized = dict(payload)
    if isinstance(sanitized.get("url"), str):
        sanitized["url"] = normalize_spotify_reference(sanitized["url"])
    return sanitized
