# Hugging Face Telegram Downloader — HTTP 401 Remediation

## Incident signature

Telegram download jobs failed with a repeated chain similar to:

```text
origin=https://dyrakarmy-downloader-primary.onrender.com status=401 circuit=open
fallback=No fallback YouTube mirror found for input URL
```

## Root cause

The Hugging Face Worker and the external Render downloader relied on separately managed values of `DOWNLOADER_API_KEY`. The Worker sent its value through `X-API-Key`, while the FastAPI service compared it with its own environment value. A missing or different value caused HTTP 401. Repeated 401 responses were counted as origin failures and opened the circuit breaker.

The Spotify URL and Telegram itself were not the primary cause. Persistent game/profile storage is a separate concern and does not repair downloader authentication.

## Remediation

The default Hugging Face profile now runs the downloader inside the same Docker container:

```text
Public Worker:       0.0.0.0:7860
Private downloader:  127.0.0.1:8081
```

At startup:

1. a cryptographically random 32-byte internal key is generated when no key is supplied;
2. the same process environment is provided to the Worker and FastAPI downloader;
3. Worker origins are replaced with `http://127.0.0.1:8081`;
4. Render backup and tertiary origins are disabled for the Hugging Face runtime;
5. the downloader storage/work directories are placed under the selected Hugging Face persistence root;
6. only port 7860 is published—port 8081 remains private.

## Telegram file delivery

The bot never sends the localhost URL to Telegram. Completed jobs generate a signed public URL under:

```text
https://dyrakarmy-dyrakarmy-platform.hf.space/api/file/<signed-token>
```

The public Worker validates the token and fetches the file internally from the localhost downloader using the generated key. Telegram `sendAudio`, channel publishing and user download links therefore remain externally reachable while the downloader stays private.

## Deployment blocker

`GET /api/hf-runtime/health` now performs both:

- downloader process health check;
- authenticated protected-route handshake.

A successful handshake deliberately returns `404` for a nonexistent probe file. That proves authentication succeeded. A missing/rejected key returns runtime HTTP 503 and blocks publication.

Expected downloader section:

```json
{
  "ok": true,
  "mode": "local-container",
  "status": 200,
  "auth_status": 404,
  "endpoint": "127.0.0.1"
}
```

## Validation matrix

- TypeScript typecheck and Worker unit tests;
- FastAPI/pytest suite;
- Docker image build with Python, yt-dlp and FFmpeg;
- unauthenticated protected route returns 401;
- authenticated missing-file route returns 404;
- public runtime health confirms local authenticated downloader;
- all Games 1–10 routes remain operational;
- optional standalone mode retains state and downloader directories after restart;
- public deployment verification rejects external downloader or failed auth.
