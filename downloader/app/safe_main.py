from __future__ import annotations

import json
from typing import Any, Awaitable, Callable

from .main import app as core_app
from .spotify_policy import sanitize_download_payload


ASGIReceive = Callable[[], Awaitable[dict[str, Any]]]
ASGISend = Callable[[dict[str, Any]], Awaitable[None]]


class SpotifySafetyMiddleware:
    """ASGI guard for downloader JSON requests.

    It normalizes public Spotify URIs and rejects payloads carrying protected
    stream keys, CDM/Widevine material, File IDs or encrypted audio streams.
    The existing FastAPI application remains responsible for URL validation,
    metadata resolution, source matching, yt-dlp and FFmpeg processing.
    """

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

        body_parts: list[bytes] = []
        while True:
            message = await receive()
            if message.get("type") != "http.request":
                continue
            body_parts.append(bytes(message.get("body") or b""))
            if sum(len(part) for part in body_parts) > self.max_json_bytes:
                await self._json_error(send, 413, "PAYLOAD_TOO_LARGE", "JSON payload is too large")
                return
            if not message.get("more_body", False):
                break

        original_body = b"".join(body_parts)
        rewritten_body = original_body

        try:
            payload = json.loads(original_body.decode("utf-8")) if original_body else {}
            sanitized = sanitize_download_payload(payload)
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

    @staticmethod
    async def _json_error(send: ASGISend, status: int, code: str, message: str) -> None:
        body = json.dumps(
            {
                "error": {
                    "code": code,
                    "message": message,
                    "retryable": False,
                },
            },
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        await send(
            {
                "type": "http.response.start",
                "status": status,
                "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"content-length", str(len(body)).encode("ascii")),
                ],
            },
        )
        await send({"type": "http.response.body", "body": body, "more_body": False})


app = SpotifySafetyMiddleware(core_app)
