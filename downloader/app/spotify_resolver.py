from __future__ import annotations

import base64
import html
import json
import os
import re
import unicodedata
import urllib.parse
import urllib.request
from dataclasses import asdict, dataclass, field
from difflib import SequenceMatcher
from typing import Any

from yt_dlp import YoutubeDL


_SPOTIFY_TRACK_RE = re.compile(
    r"(?:https?://open\.spotify\.com/track/|spotify:track:)([A-Za-z0-9]+)",
    re.IGNORECASE,
)
_AUDIO_EXTENSIONS = {"mp3", "m4a", "aac", "ogg", "opus", "flac", "wav", "webm"}
_NEGATIVE_VARIANTS = {
    "cover",
    "karaoke",
    "remix",
    "live",
    "slowed",
    "reverb",
    "nightcore",
    "instrumental",
    "sped up",
    "8d",
}
_EXPLICIT_RIGHTS_MARKERS = (
    "creativecommons.org",
    "creative commons",
    "public domain",
    "cc-by",
    "cc by",
    "cc0",
    "attribution",
    "license_ccurl",
    "artist-authorized",
    "artist authorized",
    "downloadable by uploader",
)
_DENIED_RIGHTS_MARKERS = (
    "all rights reserved",
    "standard youtube license",
    "fair use",
    "no derivative",
    "no-derivatives",
)


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(str(os.getenv(name, default)).strip())
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


AUTO_THRESHOLD = _env_int("SPOTIFY_RESOLVER_AUTO_THRESHOLD", 88, 80, 99)
REVIEW_THRESHOLD = _env_int("SPOTIFY_RESOLVER_REVIEW_THRESHOLD", 76, 60, AUTO_THRESHOLD - 1)
SPOTIFY_CLIENT_ID = os.getenv("SPOTIFY_CLIENT_ID", "").strip()
SPOTIFY_CLIENT_SECRET = os.getenv("SPOTIFY_CLIENT_SECRET", "").strip()
JAMENDO_CLIENT_ID = os.getenv("JAMENDO_CLIENT_ID", "").strip()


@dataclass(slots=True)
class SpotifyTrackMetadata:
    spotify_id: str
    title: str
    artists: list[str]
    duration_ms: int = 0
    album: str | None = None
    release_date: str | None = None
    isrc: str | None = None
    image_url: str | None = None
    preview_url: str | None = None
    playback_url: str = ""
    metadata_source: str = "spotify_oembed"

    @property
    def artist(self) -> str:
        return ", ".join(self.artists) if self.artists else "Unknown Artist"


@dataclass(slots=True)
class ResolverCandidate:
    provider: str
    title: str
    artist: str
    url: str
    duration_ms: int = 0
    album: str | None = None
    license: str | None = None
    rights_notice: str | None = None
    delivery: str = "resolver"
    downloadable: bool = True
    authorized: bool = False
    score: int = 0
    score_breakdown: dict[str, int] = field(default_factory=dict)
    warnings: list[str] = field(default_factory=list)


@dataclass(slots=True)
class ResolverDecision:
    action: str
    metadata: SpotifyTrackMetadata
    candidates: list[ResolverCandidate]
    selected: ResolverCandidate | None
    auto_threshold: int
    review_threshold: int
    reason: str


def extract_spotify_track_id(value: str) -> str | None:
    match = _SPOTIFY_TRACK_RE.search(str(value or "").strip())
    return match.group(1) if match else None


def canonical_spotify_track_url(value: str) -> str | None:
    spotify_id = extract_spotify_track_id(value)
    return f"https://open.spotify.com/track/{spotify_id}" if spotify_id else None


def _normalize(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", str(value or "")).casefold()
    normalized = re.sub(r"[^\w\s]", " ", normalized, flags=re.UNICODE)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


def _token_similarity(left: str, right: str) -> float:
    left_tokens = set(_normalize(left).split())
    right_tokens = set(_normalize(right).split())
    if not left_tokens or not right_tokens:
        return 0.0
    return (2.0 * len(left_tokens & right_tokens)) / (len(left_tokens) + len(right_tokens))


def text_similarity(left: str, right: str) -> float:
    a = _normalize(left)
    b = _normalize(right)
    if not a or not b:
        return 0.0
    sequence = SequenceMatcher(None, a, b).ratio()
    token = _token_similarity(a, b)
    containment = 1.0 if a in b or b in a else 0.0
    return max(sequence, token, containment * 0.94)


def has_explicit_rights(license_text: str | None, rights_notice: str | None = None) -> bool:
    combined = f"{license_text or ''} {rights_notice or ''}".casefold()
    if any(marker in combined for marker in _DENIED_RIGHTS_MARKERS):
        return False
    return any(marker in combined for marker in _EXPLICIT_RIGHTS_MARKERS)


def _variant_penalty(target: SpotifyTrackMetadata, candidate: ResolverCandidate) -> tuple[int, list[str]]:
    target_text = _normalize(f"{target.title} {target.artist}")
    candidate_text = _normalize(f"{candidate.title} {candidate.artist}")
    warnings: list[str] = []
    penalty = 0
    for marker in _NEGATIVE_VARIANTS:
        if marker in candidate_text and marker not in target_text:
            penalty += 12
            warnings.append(f"variant:{marker}")
    return min(36, penalty), warnings


def score_candidate(target: SpotifyTrackMetadata, candidate: ResolverCandidate) -> ResolverCandidate:
    title_score = round(45 * text_similarity(target.title, candidate.title))
    artist_score = round(30 * text_similarity(target.artist, candidate.artist))

    duration_score = 0
    if target.duration_ms > 0 and candidate.duration_ms > 0:
        delta = abs(target.duration_ms - candidate.duration_ms)
        if delta <= 1_500:
            duration_score = 15
        elif delta <= 3_000:
            duration_score = 13
        elif delta <= 6_000:
            duration_score = 10
        elif delta <= 12_000:
            duration_score = 5
        else:
            duration_score = 0
    elif target.duration_ms <= 0 or candidate.duration_ms <= 0:
        duration_score = 3

    provider_trust = {
        "jamendo": 10,
        "internet_archive": 9,
        "wikimedia_commons": 9,
        "soundcloud": 7,
        "youtube": 6,
    }.get(candidate.provider, 4)

    rights_score = provider_trust if candidate.authorized else 0
    penalty, warnings = _variant_penalty(target, candidate)
    if not candidate.authorized:
        warnings.append("rights:not-explicit")
    if not candidate.downloadable:
        warnings.append("not-downloadable")
        penalty += 20

    total = max(0, min(100, title_score + artist_score + duration_score + rights_score - penalty))
    candidate.score = total
    candidate.score_breakdown = {
        "title": title_score,
        "artist": artist_score,
        "duration": duration_score,
        "rights_trust": rights_score,
        "penalty": penalty,
    }
    candidate.warnings = warnings
    return candidate


def choose_decision(
    metadata: SpotifyTrackMetadata,
    candidates: list[ResolverCandidate],
    auto_threshold: int = AUTO_THRESHOLD,
    review_threshold: int = REVIEW_THRESHOLD,
) -> ResolverDecision:
    ranked = sorted(
        (score_candidate(metadata, candidate) for candidate in candidates),
        key=lambda candidate: (candidate.score, candidate.authorized, candidate.downloadable),
        reverse=True,
    )
    selected = ranked[0] if ranked else None

    if selected and selected.authorized and selected.downloadable and selected.score >= auto_threshold:
        return ResolverDecision(
            action="download",
            metadata=metadata,
            candidates=ranked,
            selected=selected,
            auto_threshold=auto_threshold,
            review_threshold=review_threshold,
            reason="Authorized source exceeded the automatic confidence threshold.",
        )

    if selected and selected.score >= review_threshold:
        return ResolverDecision(
            action="review",
            metadata=metadata,
            candidates=ranked,
            selected=selected,
            auto_threshold=auto_threshold,
            review_threshold=review_threshold,
            reason="A possible match was found, but it requires user review or clearer rights metadata.",
        )

    return ResolverDecision(
        action="playback",
        metadata=metadata,
        candidates=ranked,
        selected=selected,
        auto_threshold=auto_threshold,
        review_threshold=review_threshold,
        reason="No authorized candidate reached the minimum confidence threshold.",
    )


def decision_payload(decision: ResolverDecision) -> dict[str, Any]:
    return {
        "ok": True,
        "action": decision.action,
        "reason": decision.reason,
        "thresholds": {
            "auto": decision.auto_threshold,
            "review": decision.review_threshold,
        },
        "metadata": asdict(decision.metadata),
        "selected": asdict(decision.selected) if decision.selected else None,
        "candidates": [asdict(candidate) for candidate in decision.candidates[:8]],
        "safety": {
            "spotify_stream_download": False,
            "drm_or_key_extraction": False,
            "authorized_external_sources_only": True,
        },
    }


def _fetch_json(url: str, *, timeout: int = 20, headers: dict[str, str] | None = None, data: bytes | None = None) -> Any:
    request_headers = {
        "User-Agent": "DyrakArmySpotifyResolver/1.0",
        "Accept": "application/json,text/plain,*/*",
    }
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(url, headers=request_headers, data=data)
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", errors="replace"))


def _fetch_text(url: str, *, timeout: int = 20) -> str:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "DyrakArmySpotifyResolver/1.0",
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read().decode("utf-8", errors="replace")


def _spotify_access_token() -> str | None:
    if not SPOTIFY_CLIENT_ID or not SPOTIFY_CLIENT_SECRET:
        return None
    auth = base64.b64encode(f"{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}".encode("utf-8")).decode("ascii")
    data = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode("utf-8")
    payload = _fetch_json(
        "https://accounts.spotify.com/api/token",
        timeout=20,
        headers={
            "Authorization": f"Basic {auth}",
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data=data,
    )
    token = str(payload.get("access_token") or "").strip() if isinstance(payload, dict) else ""
    return token or None


def _spotify_api_metadata(spotify_id: str, playback_url: str) -> SpotifyTrackMetadata | None:
    token = _spotify_access_token()
    if not token:
        return None
    payload = _fetch_json(
        f"https://api.spotify.com/v1/tracks/{urllib.parse.quote(spotify_id)}",
        timeout=20,
        headers={"Authorization": f"Bearer {token}"},
    )
    if not isinstance(payload, dict):
        return None
    artists = [
        str(item.get("name") or "").strip()
        for item in payload.get("artists", [])
        if isinstance(item, dict) and str(item.get("name") or "").strip()
    ]
    album = payload.get("album") if isinstance(payload.get("album"), dict) else {}
    images = album.get("images") if isinstance(album, dict) else []
    external_ids = payload.get("external_ids") if isinstance(payload.get("external_ids"), dict) else {}
    image_url = ""
    if isinstance(images, list) and images and isinstance(images[0], dict):
        image_url = str(images[0].get("url") or "").strip()
    return SpotifyTrackMetadata(
        spotify_id=spotify_id,
        title=str(payload.get("name") or "Unknown Title").strip(),
        artists=artists or ["Unknown Artist"],
        duration_ms=max(0, int(payload.get("duration_ms") or 0)),
        album=str(album.get("name") or "").strip() or None,
        release_date=str(album.get("release_date") or "").strip() or None,
        isrc=str(external_ids.get("isrc") or "").strip() or None,
        image_url=image_url or None,
        preview_url=str(payload.get("preview_url") or "").strip() or None,
        playback_url=playback_url,
        metadata_source="spotify_web_api",
    )


def _meta_content(page_html: str, property_name: str) -> str:
    patterns = [
        rf'<meta[^>]+property=["\']{re.escape(property_name)}["\'][^>]+content=["\']([^"\']+)["\']',
        rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']{re.escape(property_name)}["\']',
    ]
    for pattern in patterns:
        match = re.search(pattern, page_html, re.IGNORECASE)
        if match:
            return html.unescape(match.group(1)).strip()
    return ""


def _spotify_fallback_metadata(spotify_id: str, playback_url: str) -> SpotifyTrackMetadata:
    title = "Unknown Title"
    artist = "Unknown Artist"
    image_url: str | None = None
    preview_url: str | None = None
    try:
        payload = _fetch_json(
            f"https://open.spotify.com/oembed?url={urllib.parse.quote(playback_url, safe='')}",
            timeout=20,
        )
        if isinstance(payload, dict):
            title = str(payload.get("title") or title).strip()
            image_url = str(payload.get("thumbnail_url") or "").strip() or None
    except Exception:
        pass
    try:
        page_html = _fetch_text(playback_url, timeout=20)
        description = _meta_content(page_html, "og:description")
        if description:
            parts = [part.strip() for part in re.split(r"[·•]", description) if part.strip()]
            if parts:
                artist = parts[0]
        preview_match = re.search(r'"audioPreview"\s*:\s*\{[^}]*"url"\s*:\s*"([^"]+)"', page_html)
        if preview_match:
            preview_url = preview_match.group(1).replace("\\u0026", "&").replace("\\/", "/")
    except Exception:
        pass
    return SpotifyTrackMetadata(
        spotify_id=spotify_id,
        title=title,
        artists=[artist],
        preview_url=preview_url,
        image_url=image_url,
        playback_url=playback_url,
        metadata_source="spotify_oembed",
    )


def fetch_spotify_metadata(value: str) -> SpotifyTrackMetadata:
    spotify_id = extract_spotify_track_id(value)
    if not spotify_id:
        raise ValueError("A Spotify track URL or URI is required")
    playback_url = f"https://open.spotify.com/track/{spotify_id}"
    try:
        metadata = _spotify_api_metadata(spotify_id, playback_url)
        if metadata:
            return metadata
    except Exception:
        pass
    return _spotify_fallback_metadata(spotify_id, playback_url)


def _candidate_from_ytdlp(info: dict[str, Any], provider: str) -> ResolverCandidate | None:
    url = str(info.get("webpage_url") or info.get("original_url") or "").strip()
    if not url:
        extractor = str(info.get("extractor_key") or "").lower()
        video_id = str(info.get("id") or "").strip()
        if provider == "youtube" and video_id and extractor.startswith("youtube"):
            url = f"https://www.youtube.com/watch?v={video_id}"
    if not url:
        return None
    license_text = str(info.get("license") or "").strip() or None
    rights_notice = ""
    if provider == "soundcloud" and bool(info.get("is_downloadable") or info.get("downloadable")):
        rights_notice = "downloadable by uploader"
    authorized = has_explicit_rights(license_text, rights_notice)
    return ResolverCandidate(
        provider=provider,
        title=str(info.get("track") or info.get("title") or "Untitled").strip(),
        artist=str(info.get("artist") or info.get("uploader") or info.get("channel") or "Unknown Artist").strip(),
        url=url,
        duration_ms=max(0, int(float(info.get("duration") or 0) * 1000)),
        album=str(info.get("album") or "").strip() or None,
        license=license_text,
        rights_notice=rights_notice or None,
        delivery="resolver",
        downloadable=bool(info.get("is_downloadable") or info.get("downloadable") or provider == "youtube"),
        authorized=authorized,
    )


def search_youtube_cc(metadata: SpotifyTrackMetadata, limit: int = 5) -> list[ResolverCandidate]:
    query = f"{metadata.artist} - {metadata.title} audio"
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "ignoreerrors": True,
        "default_search": "ytsearch",
    }
    results: list[ResolverCandidate] = []
    try:
        with YoutubeDL(opts) as ydl:
            raw = ydl.extract_info(f"ytsearch{max(1, min(8, limit))}:{query}", download=False)
            entries = raw.get("entries", []) if isinstance(raw, dict) else []
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                webpage_url = str(entry.get("webpage_url") or "").strip()
                if not webpage_url and entry.get("id"):
                    webpage_url = f"https://www.youtube.com/watch?v={entry['id']}"
                try:
                    detailed = ydl.extract_info(webpage_url, download=False) if webpage_url else entry
                except Exception:
                    detailed = entry
                if isinstance(detailed, dict):
                    candidate = _candidate_from_ytdlp(detailed, "youtube")
                    if candidate and candidate.authorized:
                        results.append(candidate)
    except Exception:
        return []
    return results


def search_soundcloud_downloadable(metadata: SpotifyTrackMetadata, limit: int = 5) -> list[ResolverCandidate]:
    query = f"{metadata.artist} {metadata.title}"
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "ignoreerrors": True,
    }
    results: list[ResolverCandidate] = []
    try:
        with YoutubeDL(opts) as ydl:
            raw = ydl.extract_info(f"scsearch{max(1, min(8, limit))}:{query}", download=False)
            entries = raw.get("entries", []) if isinstance(raw, dict) else []
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                candidate = _candidate_from_ytdlp(entry, "soundcloud")
                if candidate and candidate.authorized and candidate.downloadable:
                    results.append(candidate)
    except Exception:
        return []
    return results


def _first_text(value: Any) -> str:
    if isinstance(value, list):
        return _first_text(value[0]) if value else ""
    return str(value or "").strip()


def search_internet_archive(metadata: SpotifyTrackMetadata, limit: int = 5) -> list[ResolverCandidate]:
    query = urllib.parse.quote(f'mediatype:audio AND title:("{metadata.title}") AND creator:("{metadata.artist}")')
    try:
        payload = _fetch_json(
            f"https://archive.org/advancedsearch.php?q={query}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=licenseurl&rows={max(1, min(8, limit))}&output=json",
            timeout=20,
        )
    except Exception:
        return []
    docs = payload.get("response", {}).get("docs", []) if isinstance(payload, dict) else []
    results: list[ResolverCandidate] = []
    for doc in docs:
        if not isinstance(doc, dict):
            continue
        identifier = str(doc.get("identifier") or "").strip()
        if not identifier:
            continue
        try:
            item = _fetch_json(f"https://archive.org/metadata/{urllib.parse.quote(identifier)}", timeout=20)
        except Exception:
            continue
        files = item.get("files", []) if isinstance(item, dict) else []
        item_metadata = item.get("metadata", {}) if isinstance(item, dict) else {}
        license_text = _first_text(item_metadata.get("licenseurl") or doc.get("licenseurl"))
        if not has_explicit_rights(license_text):
            continue
        selected: dict[str, Any] | None = None
        for file in files:
            if not isinstance(file, dict):
                continue
            name = str(file.get("name") or "")
            ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
            if ext not in _AUDIO_EXTENSIONS:
                continue
            if str(file.get("source") or "").lower() == "derivative" and selected is not None:
                continue
            selected = file
            if str(file.get("source") or "").lower() == "original":
                break
        if not selected:
            continue
        name = str(selected.get("name") or "").strip()
        results.append(
            ResolverCandidate(
                provider="internet_archive",
                title=_first_text(item_metadata.get("title") or doc.get("title")) or metadata.title,
                artist=_first_text(item_metadata.get("creator") or doc.get("creator")) or metadata.artist,
                url=f"https://archive.org/download/{urllib.parse.quote(identifier)}/{urllib.parse.quote(name)}",
                duration_ms=max(0, int(float(selected.get("length") or 0) * 1000)),
                license=license_text,
                rights_notice="Internet Archive item carries explicit open-license metadata.",
                delivery="direct",
                downloadable=True,
                authorized=True,
            ),
        )
    return results


def search_wikimedia_commons(metadata: SpotifyTrackMetadata, limit: int = 6) -> list[ResolverCandidate]:
    params = {
        "action": "query",
        "generator": "search",
        "gsrsearch": f"filetype:audio {metadata.artist} {metadata.title}",
        "gsrnamespace": "6",
        "gsrlimit": str(max(1, min(10, limit))),
        "prop": "imageinfo",
        "iiprop": "url|mime|extmetadata",
        "format": "json",
        "origin": "*",
    }
    try:
        payload = _fetch_json(f"https://commons.wikimedia.org/w/api.php?{urllib.parse.urlencode(params)}", timeout=20)
    except Exception:
        return []
    pages = payload.get("query", {}).get("pages", {}) if isinstance(payload, dict) else {}
    results: list[ResolverCandidate] = []
    for page in pages.values() if isinstance(pages, dict) else []:
        if not isinstance(page, dict):
            continue
        infos = page.get("imageinfo", [])
        info = infos[0] if isinstance(infos, list) and infos and isinstance(infos[0], dict) else {}
        ext = info.get("extmetadata", {}) if isinstance(info.get("extmetadata"), dict) else {}
        license_url = _first_text((ext.get("LicenseUrl") or {}).get("value") if isinstance(ext.get("LicenseUrl"), dict) else "")
        license_short = _first_text((ext.get("LicenseShortName") or {}).get("value") if isinstance(ext.get("LicenseShortName"), dict) else "")
        license_text = " ".join(part for part in [license_short, license_url] if part)
        file_url = str(info.get("url") or "").strip()
        mime = str(info.get("mime") or "").lower()
        if not file_url or not mime.startswith("audio/") or not has_explicit_rights(license_text):
            continue
        artist = _first_text((ext.get("Artist") or {}).get("value") if isinstance(ext.get("Artist"), dict) else "")
        title = _first_text((ext.get("ObjectName") or {}).get("value") if isinstance(ext.get("ObjectName"), dict) else "")
        results.append(
            ResolverCandidate(
                provider="wikimedia_commons",
                title=re.sub(r"<[^>]+>", "", title) or str(page.get("title") or metadata.title).removeprefix("File:"),
                artist=re.sub(r"<[^>]+>", "", artist) or metadata.artist,
                url=file_url,
                license=license_text,
                rights_notice="Wikimedia Commons license metadata is attached to the file.",
                delivery="direct",
                downloadable=True,
                authorized=True,
            ),
        )
    return results


def search_jamendo(metadata: SpotifyTrackMetadata, limit: int = 6) -> list[ResolverCandidate]:
    if not JAMENDO_CLIENT_ID:
        return []
    params = {
        "client_id": JAMENDO_CLIENT_ID,
        "format": "json",
        "limit": str(max(1, min(10, limit))),
        "namesearch": f"{metadata.artist} {metadata.title}",
        "audioformat": "mp32",
        "include": "licenses",
    }
    try:
        payload = _fetch_json(f"https://api.jamendo.com/v3.0/tracks/?{urllib.parse.urlencode(params)}", timeout=20)
    except Exception:
        return []
    rows = payload.get("results", []) if isinstance(payload, dict) else []
    results: list[ResolverCandidate] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        audio_url = str(row.get("audio") or "").strip()
        license_url = str(row.get("license_ccurl") or "").strip()
        if not audio_url or not has_explicit_rights(license_url, "license_ccurl"):
            continue
        results.append(
            ResolverCandidate(
                provider="jamendo",
                title=str(row.get("name") or metadata.title).strip(),
                artist=str(row.get("artist_name") or metadata.artist).strip(),
                album=str(row.get("album_name") or "").strip() or None,
                url=audio_url,
                duration_ms=max(0, int(float(row.get("duration") or 0) * 1000)),
                license=license_url,
                rights_notice="Jamendo API returned an explicit Creative Commons license URL.",
                delivery="direct",
                downloadable=True,
                authorized=True,
            ),
        )
    return results


def collect_authorized_candidates(metadata: SpotifyTrackMetadata) -> list[ResolverCandidate]:
    candidates: list[ResolverCandidate] = []
    providers = (
        search_internet_archive,
        search_wikimedia_commons,
        search_jamendo,
        search_soundcloud_downloadable,
        search_youtube_cc,
    )
    for provider in providers:
        try:
            candidates.extend(provider(metadata))
        except Exception:
            continue

    seen: set[str] = set()
    unique: list[ResolverCandidate] = []
    for candidate in candidates:
        key = f"{candidate.provider}|{candidate.url.strip().lower()}"
        if key in seen:
            continue
        seen.add(key)
        unique.append(candidate)
    return unique


def resolve_spotify_reference(value: str) -> ResolverDecision:
    metadata = fetch_spotify_metadata(value)
    candidates = collect_authorized_candidates(metadata)
    return choose_decision(metadata, candidates)
