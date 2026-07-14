from __future__ import annotations

import pytest

from app.spotify_policy import (
    collect_forbidden_paths,
    normalize_spotify_reference,
    sanitize_download_payload,
)


def test_normalizes_spotify_track_uri() -> None:
    assert normalize_spotify_reference("spotify:track:0VjIjW4GlUZAMYd2vXMi3b") == (
        "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b"
    )


def test_canonicalizes_spotify_url() -> None:
    assert normalize_spotify_reference(
        "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M?si=test#fragment",
    ) == "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"


def test_keeps_non_spotify_url_unchanged() -> None:
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    assert normalize_spotify_reference(url) == url


def test_sanitizes_normal_download_payload() -> None:
    payload = {
        "job_id": "job-12345678",
        "url": "spotify:track:0VjIjW4GlUZAMYd2vXMi3b",
        "source": "spotify",
        "format": "m4a",
        "quality": "best",
    }
    sanitized = sanitize_download_payload(payload)
    assert sanitized["url"] == "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b"
    assert payload["url"].startswith("spotify:")


@pytest.mark.parametrize(
    "payload",
    [
        {"aes_key": "001122"},
        {"nested": {"file_id": "deadbeef"}},
        {"device": {"cdm_data": "opaque"}},
        {"license": {"pssh": "opaque"}},
        {"stream": "AES key: 001122"},
        {"spotify_audio_stream": "https://example.invalid/encrypted"},
    ],
)
def test_rejects_protected_stream_material(payload: dict[str, object]) -> None:
    with pytest.raises(ValueError, match="Protected-stream"):
        sanitize_download_payload(payload)


def test_reports_nested_forbidden_path() -> None:
    assert collect_forbidden_paths({"outer": [{"widevine_license": "opaque"}]}) == [
        "$.outer[0].widevine_license",
    ]
