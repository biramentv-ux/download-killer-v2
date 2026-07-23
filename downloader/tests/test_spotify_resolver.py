from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app import safe_main
from app.safe_main import SpotifySafetyMiddleware
from app.spotify_resolver import (
    ResolverCandidate,
    ResolverDecision,
    SpotifyTrackMetadata,
    choose_decision,
    extract_spotify_track_id,
    has_explicit_rights,
    score_candidate,
    text_similarity,
)


def target_track() -> SpotifyTrackMetadata:
    return SpotifyTrackMetadata(
        spotify_id="0xCX7a8DSq9idNOaAVI375",
        title="Темна ли е мъгла паднала",
        artists=["Slavi Trifonov", "Ku-Ku Band", "Nina Nikolina"],
        duration_ms=228_226,
        album="Roma e necha",
        playback_url="https://open.spotify.com/track/0xCX7a8DSq9idNOaAVI375",
        metadata_source="spotify_web_api",
    )


def authorized_candidate(**overrides: object) -> ResolverCandidate:
    values = {
        "provider": "internet_archive",
        "title": "Тъмна ли е мъгла паднала",
        "artist": "Slavi Trifonov, Ku-Ku Band, Nina Nikolina",
        "url": "https://archive.org/download/example/track.flac",
        "duration_ms": 228_000,
        "license": "https://creativecommons.org/licenses/by/4.0/",
        "rights_notice": "Creative Commons attribution",
        "delivery": "direct",
        "downloadable": True,
        "authorized": True,
    }
    values.update(overrides)
    return ResolverCandidate(**values)


def test_extracts_spotify_track_url_and_uri() -> None:
    expected = "0xCX7a8DSq9idNOaAVI375"
    assert extract_spotify_track_id(f"spotify:track:{expected}") == expected
    assert extract_spotify_track_id(f"https://open.spotify.com/track/{expected}?si=test") == expected
    assert extract_spotify_track_id("https://open.spotify.com/album/example") is None


def test_bulgarian_vowel_variant_keeps_high_title_similarity() -> None:
    assert text_similarity("Темна ли е мъгла паднала", "Тъмна ли е мъгла паднала") > 0.90


def test_exact_authorized_candidate_passes_strict_auto_gate() -> None:
    candidate = score_candidate(target_track(), authorized_candidate())
    assert candidate.score >= 88
    assert candidate.authorized is True
    decision = choose_decision(target_track(), [candidate])
    assert decision.action == "download"
    assert decision.selected is candidate


def test_cover_and_live_variants_are_penalized() -> None:
    original = score_candidate(target_track(), authorized_candidate())
    variant = score_candidate(
        target_track(),
        authorized_candidate(title="Темна ли е мъгла паднала live cover remix"),
    )
    assert variant.score < original.score
    assert any(item.startswith("variant:") for item in variant.warnings)


def test_missing_rights_never_auto_downloads() -> None:
    candidate = authorized_candidate(
        provider="youtube",
        license="Standard YouTube License",
        rights_notice="All rights reserved",
        authorized=False,
    )
    decision = choose_decision(target_track(), [candidate])
    assert decision.action in {"review", "playback"}
    assert decision.action != "download"


def test_explicit_rights_parser_rejects_all_rights_reserved() -> None:
    assert has_explicit_rights("Creative Commons Attribution 4.0") is True
    assert has_explicit_rights("https://creativecommons.org/licenses/by/4.0/") is True
    assert has_explicit_rights("All rights reserved") is False
    assert has_explicit_rights("Standard YouTube License") is False


def make_test_client(monkeypatch, decision: ResolverDecision) -> TestClient:
    inner = FastAPI()

    @inner.post("/internal/download")
    async def echo_download(request: Request) -> dict[str, object]:
        return await request.json()

    @inner.post("/internal/preview")
    async def echo_preview(request: Request) -> dict[str, object]:
        return await request.json()

    monkeypatch.setattr(safe_main, "resolve_spotify_reference", lambda _value: decision)
    return TestClient(SpotifySafetyMiddleware(inner))


def test_middleware_rewrites_high_confidence_spotify_download(monkeypatch) -> None:
    metadata = target_track()
    candidate = score_candidate(metadata, authorized_candidate())
    decision = choose_decision(metadata, [candidate])
    client = make_test_client(monkeypatch, decision)

    response = client.post(
        "/internal/download",
        json={
            "job_id": "job-spotify-1234",
            "url": metadata.playback_url,
            "source": "spotify",
            "format": "flac",
            "quality": "lossless",
        },
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["url"] == candidate.url
    assert payload["source"] == "internet_archive"
    assert payload["spotify_reference"] == metadata.playback_url
    assert payload["resolver_confidence"] >= 88


def test_middleware_returns_playback_fallback_without_creating_job(monkeypatch) -> None:
    metadata = target_track()
    decision = choose_decision(metadata, [])
    client = make_test_client(monkeypatch, decision)

    response = client.post(
        "/internal/download",
        json={
            "job_id": "job-spotify-5678",
            "url": metadata.playback_url,
            "source": "spotify",
            "format": "flac",
            "quality": "lossless",
        },
    )
    assert response.status_code == 409
    payload = response.json()
    assert payload["error"]["code"] == "SPOTIFY_PLAYBACK_FALLBACK"
    assert payload["resolver"]["metadata"]["playback_url"] == metadata.playback_url
    assert payload["resolver"]["safety"]["spotify_stream_download"] is False


def test_preview_uses_spotify_preview_when_no_authorized_file(monkeypatch) -> None:
    metadata = target_track()
    metadata.preview_url = "https://p.scdn.co/mp3-preview/example.mp3"
    decision = choose_decision(metadata, [])
    client = make_test_client(monkeypatch, decision)

    response = client.post(
        "/internal/preview",
        json={"query": metadata.playback_url, "source": "spotify"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["source"] == "spotify"
    assert payload["preview_url"] == metadata.preview_url
    assert payload["resolved_url"] == metadata.playback_url


def test_protected_stream_material_is_still_rejected(monkeypatch) -> None:
    decision = choose_decision(target_track(), [])
    client = make_test_client(monkeypatch, decision)
    response = client.post(
        "/internal/download",
        json={
            "job_id": "job-protected-1234",
            "url": target_track().playback_url,
            "source": "spotify",
            "file_id": "protected-stream-id",
        },
    )
    assert response.status_code == 400
    assert response.json()["error"]["code"] == "PROTECTED_STREAM_INPUT_REJECTED"
