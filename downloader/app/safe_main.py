from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable

from . import main as core_main
from .spotify_policy import sanitize_download_payload
from .spotify_resolver import (
    decision_payload,
    extract_spotify_track_id,
    resolve_spotify_reference,
)


ASGIReceive = Callable[[], Awaitable[dict[str, Any]]]
ASGISend = Callable[[dict[str, Any]], Awaitable[None]]


class SpotifySafetyMiddleware:
    """ASGI guard and authorized Spotify reference resolver.

    Spotify references are metadata/playback inputs only. For download/smoke
    requests the middleware resolves them to an external source with explicit
    rights metadata and a strict confidence score. Low-confidence matches are
    returned as review/playback responses instead of creating failed jobs.
    Protected-stream keys, CDM/Widevine material, File IDs and encrypted audio
    streams remain rejected before FastAPI receives the payload.
    """

    RESOLVER_PATHS = {
        "/internal/download",
        "/internal/smoke",
        "/internal/preview",
        "/internal/spotify/resolve",
    }

    def __init__(self, app: Any, max_json_bytes: int = 2 * 1024 * 1024) -> None:
        self.app = app
        self.max_json_bytes = max_json_bytes

    async def __call__(self, scope: dict[str, Any], receive: ASGIReceive, send: ASGISend) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        method = str(scope.get("method") or "GET").upper()
        path = str(scope.get("path") or "")
        headers = {
            bytes(key).lower(): bytes(value)
            for key, value in scope.get("headers", [])
        }
        content_type = headers.get(b"content-type", b"").decode("latin-1", errors="ignore").lower()

        should_inspect = (
            method in {"POST", "PUT", "PATCH"}
            and path.startswith("/internal/")
            and "application/json" in content_type
        )
        if not should_inspect:
            await self.app(scope, receive, send)
            return

        original_body = await self._read_body(receive, send)
        if original_body is None:
            return

        rewritten_body = original_body
        try:
            payload = json.loads(original_body.decode("utf-8")) if original_body else {}
            sanitized = sanitize_download_payload(payload)

            spotify_value = ""
            if isinstance(sanitized, dict):
                spotify_value = str(sanitized.get("url") or sanitized.get("query") or "").strip()

            if path in self.RESOLVER_PATHS and extract_spotify_track_id(spotify_value):
                if path == "/internal/spotify/resolve" and not self._authorized(headers):
                    await self._json_error(send, 401, "UNAUTHORIZED", "Invalid API key")
                    return

                try:
                    decision = await asyncio.to_thread(resolve_spotify_reference, spotify_value)
                except Exception as error:
                    await self._json_error(
                        send,
                        502,
                        "SPOTIFY_METADATA_UNAVAILABLE",
                        f"Spotify metadata resolution failed: {error}",
                    )
                    return

                report = decision_payload(decision)
                if path == "/internal/spotify/resolve":
                    await self._json_response(send, 200, report)
                    return

                if decision.action == "download" and decision.selected is not None:
                    sanitized = dict(sanitized)
                    sanitized["url"] = decision.selected.url
                    sanitized["source"] = decision.selected.provider
                    sanitized["spotify_reference"] = decision.metadata.playback_url
                    sanitized["resolver_confidence"] = decision.selected.score
                    sanitized["resolver_license"] = decision.selected.license
                elif path == "/internal/preview" and decision.metadata.preview_url:
                    await self._json_response(
                        send,
                        200,
                        {
                            "title": decision.metadata.title,
                            "artist": decision.metadata.artist,
                            "duration": round(decision.metadata.duration_ms / 1000),
                            "thumbnail": decision.metadata.image_url,
                            "preview_url": decision.metadata.preview_url,
                            "source": "spotify",
                            "resolved_url": decision.metadata.playback_url,
                            "fallback_used": False,
                        },
                    )
                    return
                else:
                    code = (
                        "SPOTIFY_SOURCE_REVIEW_REQUIRED"
                        if decision.action == "review"
                        else "SPOTIFY_PLAYBACK_FALLBACK"
                    )
                    await self._json_response(
                        send,
                        409,
                        {
                            "error": {
                                "code": code,
                                "message": decision.reason,
                                "retryable": False,
                            },
                            "resolver": report,
                        },
                    )
                    return

            rewritten_body = json.dumps(
                sanitized,
                ensure_ascii=False,
                separators=(",", ":"),
            ).encode("utf-8")
        except ValueError as error:
            await self._json_error(send, 400, "PROTECTED_STREAM_INPUT_REJECTED", str(error))
            return
        except (UnicodeDecodeError, json.JSONDecodeError):
            # Let FastAPI/Pydantic return the normal malformed-JSON response.
            rewritten_body = original_body

        delivered = False

        async def replay_receive() -> dict[str, Any]:
            nonlocal delivered
            if delivered:
                return {"type": "http.request", "body": b"", "more_body": False}
            delivered = True
            return {"type": "http.request", "body": rewritten_body, "more_body": False}

        new_headers: list[tuple[bytes, bytes]] = []
        for key, value in scope.get("headers", []):
            if bytes(key).lower() != b"content-length":
                new_headers.append((bytes(key), bytes(value)))
        new_headers.append((b"content-length", str(len(rewritten_body)).encode("ascii")))

        guarded_scope = dict(scope)
        guarded_scope["headers"] = new_headers
        await self.app(guarded_scope, replay_receive, send)

    async def _read_body(self, receive: ASGIReceive, send: ASGISend) -> bytes | None:
        body_parts: list[bytes] = []
        total = 0
        while True:
            message = await receive()
            if message.get("type") != "http.request":
                continue
            part = bytes(message.get("body") or b"")
            total += len(part)
            if total > self.max_json_bytes:
                await self._json_error(send, 413, "PAYLOAD_TOO_LARGE", "JSON payload is too large")
                return None
            body_parts.append(part)
            if not message.get("more_body", False):
                return b"".join(body_parts)

    @staticmethod
    def _authorized(headers: dict[bytes, bytes]) -> bool:
        provided = headers.get(b"x-api-key", b"").decode("utf-8", errors="ignore")
        expected = str(core_main.API_KEY or "")
        if not provided or not expected or len(provided) != len(expected):
            return False
        mismatch = 0
        for left, right in zip(provided.encode("utf-8"), expected.encode("utf-8")):
            mismatch |= left ^ right
        return mismatch == 0

    @staticmethod
    async def _json_response(send: ASGISend, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"cache-control", b"no-store"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            },
        )
        await send({"type": "http.response.body", "body": body, "more_body": False})

    @classmethod
    async def _json_error(cls, send: ASGISend, status: int, code: str, message: str) -> None:
        await cls._json_response(
            send,
            status,
            {
                "error": {
                    "code": code,
                    "message": message,
                    "retryable": False,
                },
            },
        )


app = SpotifySafetyMiddleware(core_main.app)
