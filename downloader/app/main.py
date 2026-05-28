from __future__ import annotations

import base64
import json
import html
import mimetypes
import os
import re
import shutil
import tempfile
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from yt_dlp import YoutubeDL

API_KEY = os.getenv('DOWNLOADER_API_KEY', 'change-me')
PUBLIC_BASE_URL = os.getenv('DOWNLOADER_PUBLIC_BASE_URL', 'http://localhost:8081').rstrip('/')
STORAGE_DIR = Path(os.getenv('DOWNLOADER_STORAGE_DIR', '/tmp/sounddrop-files')).resolve()
STORAGE_DIR.mkdir(parents=True, exist_ok=True)

SUPPORTED_FORMATS = {'mp3', 'flac', 'ogg', 'm4a', 'opus', 'wav'}
SUPPORTED_QUALITIES = {'320', '256', '192', '128', '96', 'best', 'lossless'}
FALLBACK_SOURCES = {'spotify', 'deezer', 'apple'}
SPOTIFY_CLIENT_ID = os.getenv('SPOTIFY_CLIENT_ID', '').strip()
SPOTIFY_CLIENT_SECRET = os.getenv('SPOTIFY_CLIENT_SECRET', '').strip()

app = FastAPI(title='SoundDrop Downloader API', version='7.1.0')


class SearchRequest(BaseModel):
  query: str = Field(min_length=1, max_length=500)
  source: str = 'all'
  limit: int = Field(default=8, ge=1, le=20)


class SearchItem(BaseModel):
  id: str
  title: str
  artist: str
  album: str | None = None
  duration: int = 0
  thumbnail: str | None = None
  source: str
  url: str
  year: int | None = None


class SearchResponse(BaseModel):
  results: list[SearchItem]


class DownloadRequest(BaseModel):
  job_id: str = Field(min_length=8, max_length=100)
  url: str = Field(min_length=5, max_length=2000)
  source: str = 'unknown'
  format: str = 'mp3'
  quality: str = '320'


class DownloadResponse(BaseModel):
  download_url: str
  title: str
  artist: str
  duration: int
  file_size: int
  source: str
  resolved_url: str
  fallback_used: bool
  mime_type: str
  filename: str


class PlaylistResolveRequest(BaseModel):
  url: str = Field(min_length=5, max_length=2000)
  source: str = 'unknown'


class PlaylistTrack(BaseModel):
  title: str
  artist: str
  source: str
  url: str


class PlaylistResolveResponse(BaseModel):
  title: str
  source: str
  total: int
  tracks: list[PlaylistTrack]


def require_api_key(x_api_key: str | None = Header(default=None, alias='X-API-Key')) -> None:
  if x_api_key != API_KEY:
    raise HTTPException(status_code=401, detail='Invalid API key')


def is_url(value: str) -> bool:
  try:
    from urllib.parse import urlparse

    parsed = urlparse(value)
    return parsed.scheme in {'http', 'https'}
  except Exception:
    return False


def detect_source(url: str, fallback: str = 'unknown') -> str:
  lower = url.lower()
  if 'youtube.com' in lower or 'youtu.be' in lower or 'music.youtube.com' in lower:
    return 'youtube'
  if 'spotify.com' in lower:
    return 'spotify'
  if 'soundcloud.com' in lower:
    return 'soundcloud'
  if 'deezer.com' in lower:
    return 'deezer'
  if 'music.apple.com' in lower or 'itunes.apple.com' in lower:
    return 'apple'
  return (fallback or 'unknown').lower()


def is_playlist_url(raw_url: str) -> bool:
  if not is_url(raw_url):
    return False
  try:
    parsed = urllib.parse.urlparse(raw_url)
  except Exception:
    return False

  host = parsed.netloc.lower()
  path = parsed.path.lower()
  query = urllib.parse.parse_qs(parsed.query)

  if host.endswith('youtube.com') and query.get('list'):
    return True
  if 'playlist' in path:
    return True
  if '/sets/' in path:
    return True
  return False


def normalize_result_url(item: dict[str, Any]) -> str:
  url = str(item.get('webpage_url') or item.get('url') or '').strip()
  if url and url.startswith('http'):
    return url
  extractor_key = str(item.get('extractor_key') or '').lower()
  video_id = str(item.get('id') or '').strip()
  if video_id and extractor_key.startswith('youtube'):
    return f'https://www.youtube.com/watch?v={video_id}'
  return ''


def extract_spotify_playlist_id(raw_url: str) -> str | None:
  match = re.search(r'spotify\.com/playlist/([a-zA-Z0-9]+)', raw_url)
  return match.group(1) if match else None


def extract_deezer_playlist_id(raw_url: str) -> str | None:
  match = re.search(r'deezer\.com/(?:[a-z]{2}/)?playlist/([0-9]+)', raw_url)
  return match.group(1) if match else None


def fetch_json(url: str, timeout_seconds: int = 20, headers: dict[str, str] | None = None) -> Any:
  request_headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; SoundDropDownloader/7.1)',
    'Accept': 'application/json,text/plain,*/*',
  }
  if headers:
    request_headers.update(headers)

  request = urllib.request.Request(url, headers=request_headers)
  with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
    raw = response.read().decode('utf-8', errors='replace')
  return json.loads(raw)


def fetch_text(url: str, timeout_seconds: int = 20, headers: dict[str, str] | None = None) -> str:
  request_headers = {
    'User-Agent': 'Mozilla/5.0 (compatible; SoundDropDownloader/7.1)',
    'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
  }
  if headers:
    request_headers.update(headers)

  request = urllib.request.Request(url, headers=request_headers)
  with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
    return response.read().decode('utf-8', errors='replace')


def get_spotify_access_token() -> str:
  try:
    payload = fetch_json(
      'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
      timeout_seconds=20,
    )
    if isinstance(payload, dict):
      token = str(payload.get('accessToken') or '').strip()
      if token:
        return token
  except Exception:
    pass

  if not SPOTIFY_CLIENT_ID or not SPOTIFY_CLIENT_SECRET:
    raise RuntimeError(
      'Spotify access token unavailable. Provide SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to enable playlist extraction.',
    )

  auth = base64.b64encode(f'{SPOTIFY_CLIENT_ID}:{SPOTIFY_CLIENT_SECRET}'.encode('utf-8')).decode('ascii')
  data = urllib.parse.urlencode({'grant_type': 'client_credentials'}).encode('utf-8')
  request = urllib.request.Request(
    'https://accounts.spotify.com/api/token',
    method='POST',
    data=data,
    headers={
      'Authorization': f'Basic {auth}',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': 'SoundDropDownloader/7.1',
    },
  )

  with urllib.request.urlopen(request, timeout=20) as response:
    raw = response.read().decode('utf-8', errors='replace')
  payload = json.loads(raw)
  if not isinstance(payload, dict):
    raise RuntimeError('Spotify token endpoint returned invalid payload')
  token = str(payload.get('access_token') or '').strip()
  if not token:
    raise RuntimeError('Spotify token endpoint did not return access_token')
  return token


def extract_og_values(page_html: str) -> tuple[str, str]:
  title_match = re.search(
    r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']',
    page_html,
    re.IGNORECASE,
  )
  desc_match = re.search(
    r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)["\']',
    page_html,
    re.IGNORECASE,
  )
  title = html.unescape(title_match.group(1)).strip() if title_match else ''
  description = html.unescape(desc_match.group(1)).strip() if desc_match else ''
  return title, description


def extract_artist_from_description(description: str) -> str:
  if not description:
    return ''
  # Common music page patterns use middle-dot separators.
  parts = [segment.strip() for segment in re.split(r'[·•]', description) if segment.strip()]
  return parts[0] if parts else ''


def extract_spotify_metadata(raw_url: str) -> tuple[str, str] | None:
  try:
    oembed_url = f'https://open.spotify.com/oembed?url={urllib.parse.quote(raw_url, safe="")}'
    payload = fetch_json(oembed_url, timeout_seconds=20)
    title = str(payload.get('title') or '').strip() if isinstance(payload, dict) else ''

    page_html = fetch_text(raw_url, timeout_seconds=20)
    _, description = extract_og_values(page_html)
    artist = extract_artist_from_description(description)

    if not title and not artist:
      return None
    return title or 'Unknown Title', artist or 'Unknown Artist'
  except Exception:
    return None


def extract_og_metadata(raw_url: str) -> tuple[str, str] | None:
  try:
    page_html = fetch_text(raw_url, timeout_seconds=20)
    title, description = extract_og_values(page_html)
    artist = extract_artist_from_description(description)
    if not title and not artist:
      return None
    return title or 'Unknown Title', artist or 'Unknown Artist'
  except Exception:
    return None


def extract_entries(raw: dict[str, Any]) -> list[dict[str, Any]]:
  entries = raw.get('entries')
  if isinstance(entries, list):
    return [entry for entry in entries if isinstance(entry, dict)]
  return [raw]


def normalize_item(item: dict[str, Any], requested_source: str) -> SearchItem | None:
  url = item.get('webpage_url') or item.get('url') or ''
  if url and not str(url).startswith('http'):
    if item.get('extractor_key', '').lower().startswith('youtube') and item.get('id'):
      url = f"https://www.youtube.com/watch?v={item['id']}"

  if not url:
    return None

  title = str(item.get('title') or item.get('track') or '').strip() or 'Untitled'
  artist = str(item.get('artist') or item.get('uploader') or item.get('channel') or 'Unknown').strip()
  source = detect_source(str(url), requested_source)

  duration_value = item.get('duration')
  duration = int(duration_value) if isinstance(duration_value, (int, float)) else 0

  item_id = str(item.get('id') or uuid.uuid4().hex)

  year = None
  upload_date = item.get('upload_date')
  if isinstance(upload_date, str) and len(upload_date) >= 4 and upload_date[:4].isdigit():
    year = int(upload_date[:4])

  return SearchItem(
    id=item_id,
    title=title,
    artist=artist,
    duration=duration,
    thumbnail=item.get('thumbnail'),
    source=source,
    url=str(url),
    year=year,
    album=item.get('album'),
  )


def make_ydl_search(query: str, limit: int) -> list[SearchItem]:
  search_query = query if is_url(query) else f'ytsearch{limit}:{query}'
  opts = {
    'quiet': True,
    'no_warnings': True,
    'skip_download': True,
    'noplaylist': not is_url(query),
    'extract_flat': 'in_playlist',
    'default_search': 'auto',
    'ignoreerrors': True,
  }

  with YoutubeDL(opts) as ydl:
    raw = ydl.extract_info(search_query, download=False)

  items: list[SearchItem] = []
  for entry in extract_entries(raw):
    normalized = normalize_item(entry, 'all')
    if normalized:
      items.append(normalized)

  return items[:limit]


def choose_quality(requested_format: str, requested_quality: str) -> str:
  if requested_quality == 'lossless' or requested_format in {'flac', 'wav'}:
    return '0'
  if requested_quality == 'best':
    return '0'
  return requested_quality


def run_download(job_id: str, url: str, audio_format: str, audio_quality: str) -> tuple[Path, dict[str, Any]]:
  work_dir = Path(tempfile.mkdtemp(prefix=f'sounddrop-{job_id}-'))
  output_template = str(work_dir / '%(id)s.%(ext)s')

  ydl_opts = {
    'quiet': True,
    'no_warnings': True,
    'ignoreerrors': False,
    'noplaylist': True,
    'format': 'bestaudio/best',
    'extractor_args': {
      'youtube': {
        # Improves reliability when default web client is rate-limited or bot-gated.
        'player_client': ['tv', 'ios', 'android'],
      },
    },
    'outtmpl': output_template,
    'postprocessors': [
      {
        'key': 'FFmpegExtractAudio',
        'preferredcodec': audio_format,
        'preferredquality': audio_quality,
      },
    ],
  }

  try:
    with YoutubeDL(ydl_opts) as ydl:
      info = ydl.extract_info(url, download=True)

    if not isinstance(info, dict):
      raise RuntimeError('Download extractor did not return metadata')

    prefix = str(info.get('id') or '')
    candidates = [file for file in work_dir.glob(f'{prefix}.*') if file.is_file()] if prefix else list(work_dir.glob('*'))
    if not candidates:
      candidates = [file for file in work_dir.glob('*') if file.is_file()]
    if not candidates:
      raise RuntimeError('No file produced by yt-dlp')

    output = max(candidates, key=lambda file: file.stat().st_mtime)
    return output, info
  except Exception:
    shutil.rmtree(work_dir, ignore_errors=True)
    raise


def extract_track_metadata(url: str) -> tuple[str, str]:
  source = detect_source(url)
  if source == 'spotify':
    spotify_meta = extract_spotify_metadata(url)
    if spotify_meta:
      return spotify_meta

  og_meta = extract_og_metadata(url)
  if og_meta:
    return og_meta

  opts = {
    'quiet': True,
    'no_warnings': True,
    'skip_download': True,
    'noplaylist': True,
    'default_search': 'auto',
    'ignoreerrors': True,
    'extractor_args': {
      'youtube': {
        'player_client': ['tv', 'ios', 'android'],
      },
    },
  }

  with YoutubeDL(opts) as ydl:
    info = ydl.extract_info(url, download=False)

  if not isinstance(info, dict):
    raise RuntimeError('Could not extract metadata from source URL')

  title = str(info.get('track') or info.get('title') or '').strip()
  artist = str(info.get('artist') or info.get('uploader') or info.get('channel') or '').strip()

  if not title and not artist:
    raise RuntimeError('Source metadata is empty')

  return title or 'Unknown Title', artist or 'Unknown Artist'


def find_youtube_mirror_url(title: str, artist: str) -> str:
  base_queries = [
    f'{artist} - {title} audio',
    f'{title} audio',
    title,
  ]

  query_variants: list[str] = []
  for item in base_queries:
    normalized = item.strip()
    if not normalized:
      continue
    query_variants.append(normalized)
    ascii_variant = normalized.encode('ascii', errors='ignore').decode('ascii').strip()
    if ascii_variant and ascii_variant != normalized:
      query_variants.append(ascii_variant)

  opts = {
    'quiet': True,
    'no_warnings': True,
    'skip_download': True,
    'noplaylist': True,
    'default_search': 'ytsearch',
    'ignoreerrors': True,
  }

  with YoutubeDL(opts) as ydl:
    for query in query_variants:
      try:
        info = ydl.extract_info(f'ytsearch1:{query}', download=False)
      except Exception:
        continue
      entries = extract_entries(info) if isinstance(info, dict) else []
      if not entries:
        continue

      first = entries[0]
      normalized = normalize_item(first, 'youtube')
      if normalized:
        return normalized.url

  raise RuntimeError('No YouTube mirror found for fallback')


def normalize_playlist_entry(item: dict[str, Any], requested_source: str, index: int) -> PlaylistTrack | None:
  url = normalize_result_url(item)
  source = detect_source(url or str(item.get('url') or ''), requested_source)
  title = str(item.get('title') or item.get('track') or f'Track {index}').strip() or f'Track {index}'
  artist = str(item.get('artist') or item.get('uploader') or item.get('channel') or 'Unknown Artist').strip() or 'Unknown Artist'

  if not url and source in FALLBACK_SOURCES:
    fallback_url = str(item.get('url') or '').strip()
    if fallback_url.startswith('http'):
      url = fallback_url

  if not url:
    return None

  return PlaylistTrack(
    title=title,
    artist=artist,
    source=source,
    url=url,
  )


def resolve_playlist_with_ytdlp(url: str, source: str) -> PlaylistResolveResponse:
  opts = {
    'quiet': True,
    'no_warnings': True,
    'skip_download': True,
    'extract_flat': 'in_playlist',
    'ignoreerrors': True,
  }
  with YoutubeDL(opts) as ydl:
    raw = ydl.extract_info(url, download=False)

  if not isinstance(raw, dict):
    raise RuntimeError('Playlist extraction returned invalid payload')

  title = str(raw.get('title') or raw.get('playlist_title') or 'Playlist').strip() or 'Playlist'
  entries = extract_entries(raw)
  tracks: list[PlaylistTrack] = []
  for index, item in enumerate(entries, start=1):
    track = normalize_playlist_entry(item, source, index)
    if track:
      tracks.append(track)

  return PlaylistResolveResponse(
    title=title,
    source=source,
    total=len(tracks),
    tracks=tracks,
  )


def resolve_spotify_playlist(url: str) -> PlaylistResolveResponse:
  playlist_id = extract_spotify_playlist_id(url)
  if not playlist_id:
    raise RuntimeError('Invalid Spotify playlist URL')

  access_token = get_spotify_access_token()

  headers = {'Authorization': f'Bearer {access_token}'}
  playlist = fetch_json(f'https://api.spotify.com/v1/playlists/{playlist_id}', timeout_seconds=20, headers=headers)
  playlist_title = str(playlist.get('name') or 'Spotify Playlist').strip() if isinstance(playlist, dict) else 'Spotify Playlist'

  tracks: list[PlaylistTrack] = []
  next_url = f'https://api.spotify.com/v1/playlists/{playlist_id}/tracks?limit=100&offset=0'
  while next_url:
    page = fetch_json(next_url, timeout_seconds=30, headers=headers)
    if not isinstance(page, dict):
      break

    rows = page.get('items')
    if not isinstance(rows, list):
      break

    for row in rows:
      if not isinstance(row, dict):
        continue
      track = row.get('track')
      if not isinstance(track, dict):
        continue

      title = str(track.get('name') or '').strip() or 'Unknown Title'
      artists_raw = track.get('artists')
      artists: list[str] = []
      if isinstance(artists_raw, list):
        for artist_row in artists_raw:
          if isinstance(artist_row, dict):
            artist_name = str(artist_row.get('name') or '').strip()
            if artist_name:
              artists.append(artist_name)
      artist = ', '.join(artists) if artists else 'Unknown Artist'

      external_urls = track.get('external_urls')
      track_url = ''
      if isinstance(external_urls, dict):
        track_url = str(external_urls.get('spotify') or '').strip()
      if not track_url:
        continue

      tracks.append(
        PlaylistTrack(
          title=title,
          artist=artist,
          source='spotify',
          url=track_url,
        ),
      )

    next_value = page.get('next')
    next_url = str(next_value).strip() if isinstance(next_value, str) and next_value.strip() else ''

  return PlaylistResolveResponse(
    title=playlist_title,
    source='spotify',
    total=len(tracks),
    tracks=tracks,
  )


def resolve_deezer_playlist(url: str) -> PlaylistResolveResponse:
  playlist_id = extract_deezer_playlist_id(url)
  if not playlist_id:
    raise RuntimeError('Invalid Deezer playlist URL')

  playlist = fetch_json(f'https://api.deezer.com/playlist/{playlist_id}', timeout_seconds=20)
  playlist_title = str(playlist.get('title') or 'Deezer Playlist').strip() if isinstance(playlist, dict) else 'Deezer Playlist'

  tracks: list[PlaylistTrack] = []
  next_url = f'https://api.deezer.com/playlist/{playlist_id}/tracks?limit=100&index=0'
  while next_url:
    page = fetch_json(next_url, timeout_seconds=20)
    if not isinstance(page, dict):
      break

    rows = page.get('data')
    if not isinstance(rows, list):
      break

    for row in rows:
      if not isinstance(row, dict):
        continue

      title = str(row.get('title') or '').strip() or 'Unknown Title'
      artist_obj = row.get('artist')
      artist = 'Unknown Artist'
      if isinstance(artist_obj, dict):
        artist = str(artist_obj.get('name') or '').strip() or 'Unknown Artist'
      link = str(row.get('link') or '').strip()
      if not link:
        continue

      tracks.append(
        PlaylistTrack(
          title=title,
          artist=artist,
          source='deezer',
          url=link,
        ),
      )

    next_value = page.get('next')
    next_url = str(next_value).strip() if isinstance(next_value, str) and next_value.strip() else ''

  return PlaylistResolveResponse(
    title=playlist_title,
    source='deezer',
    total=len(tracks),
    tracks=tracks,
  )


def resolve_playlist(url: str, source: str) -> PlaylistResolveResponse:
  detected_source = detect_source(url, source)
  if not is_playlist_url(url):
    raise RuntimeError('URL is not recognized as a playlist')

  try:
    return resolve_playlist_with_ytdlp(url, detected_source)
  except Exception as primary_error:
    if detected_source == 'spotify':
      return resolve_spotify_playlist(url)
    if detected_source == 'deezer':
      return resolve_deezer_playlist(url)
    raise RuntimeError(str(primary_error)) from primary_error


@app.get('/health')
def health() -> dict[str, Any]:
  return {'ok': True, 'service': 'sounddrop-downloader', 'storage': str(STORAGE_DIR)}


@app.post('/internal/search', response_model=SearchResponse, dependencies=[Depends(require_api_key)])
def internal_search(payload: SearchRequest) -> SearchResponse:
  source = (payload.source or 'all').strip().lower()

  # Mirror-oriented fallback: Spotify/Deezer/Apple are resolved via YouTube search.
  effective_source = 'youtube' if source in FALLBACK_SOURCES else source
  items = make_ydl_search(payload.query.strip(), payload.limit)

  if effective_source != 'all':
    filtered = [item for item in items if item.source == effective_source]
    if filtered:
      items = filtered

  return SearchResponse(results=items)


@app.post('/internal/playlist/resolve', response_model=PlaylistResolveResponse, dependencies=[Depends(require_api_key)])
def internal_playlist_resolve(payload: PlaylistResolveRequest) -> PlaylistResolveResponse:
  if not is_url(payload.url):
    raise HTTPException(status_code=400, detail='Invalid URL')
  if not is_playlist_url(payload.url):
    raise HTTPException(status_code=400, detail='URL is not a playlist')

  try:
    return resolve_playlist(payload.url.strip(), (payload.source or 'unknown').strip().lower())
  except Exception as error:
    raise HTTPException(status_code=502, detail=f'Playlist resolve failed: {error}') from error


@app.post('/internal/download', response_model=DownloadResponse, dependencies=[Depends(require_api_key)])
def internal_download(payload: DownloadRequest) -> DownloadResponse:
  audio_format = payload.format.lower().strip()
  audio_quality = payload.quality.lower().strip()

  if audio_format not in SUPPORTED_FORMATS:
    raise HTTPException(status_code=400, detail='Unsupported format')
  if audio_quality not in SUPPORTED_QUALITIES:
    raise HTTPException(status_code=400, detail='Unsupported quality')
  if not is_url(payload.url):
    raise HTTPException(status_code=400, detail='Invalid URL')

  ffmpeg_quality = choose_quality(audio_format, audio_quality)

  initial_source = detect_source(payload.url, payload.source)
  resolved_source = initial_source
  resolved_url = payload.url
  fallback_used = False

  # Primary fallback path: Spotify/Deezer/Apple links are mirrored to YouTube before download.
  if initial_source in FALLBACK_SOURCES:
    try:
      title, artist = extract_track_metadata(payload.url)
      resolved_url = find_youtube_mirror_url(title, artist)
      resolved_source = 'youtube'
      fallback_used = True
    except Exception as fallback_error:
      # Keep original URL for last-resort download attempt.
      print(f'[fallback-warning] {payload.url}: {fallback_error}')

  try:
    output, info = run_download(payload.job_id, resolved_url, audio_format, ffmpeg_quality)
  except Exception as primary_error:
    if not fallback_used and initial_source in FALLBACK_SOURCES:
      try:
        title, artist = extract_track_metadata(payload.url)
        resolved_url = find_youtube_mirror_url(title, artist)
        resolved_source = 'youtube'
        fallback_used = True
        output, info = run_download(payload.job_id, resolved_url, audio_format, ffmpeg_quality)
      except Exception as secondary_error:
        raise HTTPException(
          status_code=502,
          detail=f'Download failed. primary={primary_error}; fallback={secondary_error}',
        ) from secondary_error
    else:
      raise HTTPException(status_code=502, detail=f'Download failed: {primary_error}') from primary_error

  file_id = f"{payload.job_id}-{uuid.uuid4().hex}.{audio_format}"
  target = STORAGE_DIR / file_id
  target.parent.mkdir(parents=True, exist_ok=True)

  shutil.move(str(output), target)
  shutil.rmtree(output.parent, ignore_errors=True)

  stat = target.stat()
  mime_type = mimetypes.guess_type(target.name)[0] or 'application/octet-stream'

  title = str(info.get('track') or info.get('title') or 'Unknown Title')
  artist = str(info.get('artist') or info.get('uploader') or info.get('channel') or 'Unknown Artist')
  duration_value = info.get('duration')
  duration = int(duration_value) if isinstance(duration_value, (int, float)) else 0

  return DownloadResponse(
    download_url=f'{PUBLIC_BASE_URL}/internal/files/{file_id}',
    title=title,
    artist=artist,
    duration=duration,
    file_size=stat.st_size,
    source=resolved_source,
    resolved_url=resolved_url,
    fallback_used=fallback_used,
    mime_type=mime_type,
    filename=target.name,
  )


@app.get('/internal/files/{file_id}', dependencies=[Depends(require_api_key)])
def internal_file(file_id: str) -> FileResponse:
  safe_name = Path(file_id).name
  target = STORAGE_DIR / safe_name
  if not target.exists() or not target.is_file():
    raise HTTPException(status_code=404, detail='File not found')

  return FileResponse(
    path=target,
    media_type=mimetypes.guess_type(target.name)[0] or 'application/octet-stream',
    filename=target.name,
  )
