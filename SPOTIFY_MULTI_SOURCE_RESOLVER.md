# Spotify Multi-Source Resolver

## Purpose

Spotify links are used as canonical metadata and playback references. The application does not treat a Spotify link as a direct audio-file URL.

The resolver replaces the old first-result fallback with this controlled flow:

```text
Spotify track
  -> canonical metadata
  -> search across authorized external sources
  -> deterministic confidence score
  -> download only when rights and score pass
  -> review or Spotify playback fallback otherwise
```

## Source policy

The resolver evaluates results from the existing DyrakArmy source catalog, including Internet Archive, Wikimedia Commons, Jamendo, SoundCloud, YouTube, Audius and MusicBrainz.

Automatic selection requires all of the following:

- a downloadable external source;
- explicit public, Creative Commons, artist-authorized or user-owned rights information;
- a confidence score at or above the automatic threshold.

Generic results and results without explicit rights information are never selected automatically.

## Confidence score

Maximum score: `100`.

| Signal | Maximum |
|---|---:|
| Title similarity | 45 |
| Artist similarity | 30 |
| Duration proximity | 15 |
| Provider and rights trust | 10 |

Penalties are applied to versions such as cover, karaoke, remix, live, slowed, reverb, nightcore, instrumental, sped-up and 8D when those terms are absent from the Spotify target.

Default thresholds:

```text
SPOTIFY_RESOLVER_AUTO_THRESHOLD=88
SPOTIFY_RESOLVER_REVIEW_THRESHOLD=76
```

Decision rules:

- `download`: authorized candidate at or above 88;
- `review`: candidate at or above 76 that still needs user or rights review;
- `playback`: no acceptable candidate.

## Telegram behavior

The resolver executes before Telegram creates a download job.

For an authorized high-confidence match, the request is routed to the selected external source and the existing queue and signed file delivery remain unchanged.

For review or playback decisions, no failed job is created. The bot sends:

- the canonical title, artists and duration when available;
- the reason automatic processing was rejected;
- the best candidate and confidence score when one exists;
- an `Open in Spotify` button;
- optional review and DyrakArmy Mini App buttons.

## Hugging Face configuration

The Docker Space continues to use the native free public host:

```text
https://dyrakarmy-dyrakarmy-platform.hf.space
```

No custom domain or PRO account is required.

For complete Spotify metadata, configure these as private **Space Secrets**:

```text
SPOTIFY_CLIENT_ID
SPOTIFY_CLIENT_SECRET
```

Optional public Space Variables:

```text
SPOTIFY_RESOLVER_AUTO_THRESHOLD=88
SPOTIFY_RESOLVER_REVIEW_THRESHOLD=76
```

The Spotify account connection used by ChatGPT is separate from the DyrakArmy application and does not automatically configure these server credentials.

## APIs

Public Worker resolver:

```text
POST /api/spotify/resolve
Content-Type: application/json

{"url":"https://open.spotify.com/track/..."}
```

Private localhost downloader resolver:

```text
POST /internal/spotify/resolve
X-API-Key: <internal-key>
Content-Type: application/json

{"url":"https://open.spotify.com/track/..."}
```

Both responses contain canonical metadata, ranked candidates, thresholds, decision and safety status.

## Regression identity

The test suite includes the catalog identity used in the reported Telegram case:

```text
Темна ли е мъгла паднала
Slavi Trifonov, Ku-Ku Band, Nina Nikolina
228226 ms
Spotify track ID: 0xCX7a8DSq9idNOaAVI375
```

The Bulgarian spelling variation `Темна` / `Тъмна` must remain a high-similarity match, while alternate versions receive penalties.

## CI gate

`.github/workflows/spotify-resolver-check.yml` runs three independent checks:

1. complete Worker TypeScript typecheck;
2. dedicated Worker resolver and Telegram tests;
3. Python syntax validation and downloader resolver tests.

All logs and exit statuses are uploaded as `spotify-resolver-diagnostics`, including when a check fails. The general Hugging Face migration workflow separately builds and starts the complete Docker Space image.
