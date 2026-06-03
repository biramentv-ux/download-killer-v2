from __future__ import annotations

import base64
import calendar
import hashlib
import json
import html
import mimetypes
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import zipfile
import urllib.parse
import urllib.error
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from fastapi import BackgroundTasks, Depends, FastAPI, Header, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from yt_dlp import YoutubeDL

API_KEY = os.getenv('DOWNLOADER_API_KEY', 'change-me')
PUBLIC_BASE_URL = os.getenv('DOWNLOADER_PUBLIC_BASE_URL', 'http://localhost:8081').rstrip('/')
STORAGE_DIR = Path(os.getenv('DOWNLOADER_STORAGE_DIR', '/tmp/sounddrop-files')).resolve()
STORAGE_DIR.mkdir(parents=True, exist_ok=True)
WORK_DIR = Path(os.getenv('DOWNLOADER_WORK_DIR', '/tmp/sounddrop-work')).resolve()
WORK_DIR.mkdir(parents=True, exist_ok=True)

SUPPORTED_FORMATS = {'mp3', 'flac', 'ogg', 'm4a', 'opus', 'wav'}
SUPPORTED_QUALITIES = {'320', '256', '192', '128', '96', 'best', 'lossless'}
FALLBACK_SOURCES = {'spotify', 'deezer', 'apple'}
SPOTIFY_CLIENT_ID = os.getenv('SPOTIFY_CLIENT_ID', '').strip()
SPOTIFY_CLIENT_SECRET = os.getenv('SPOTIFY_CLIENT_SECRET', '').strip()
PLAYLIST_WORKFLOW_BATCH_SIZE = max(1, min(200, int(os.getenv('PLAYLIST_WORKFLOW_BATCH_SIZE', '50'))))
PLAYLIST_WORKFLOW_RETENTION_SECONDS = max(300, int(os.getenv('PLAYLIST_WORKFLOW_RETENTION_SECONDS', '86400')))
PLAYLIST_ZIP_MAX_FILES = max(1, int(os.getenv('PLAYLIST_ZIP_MAX_FILES', '5000')))
TEMPORAL_NAMESPACE = os.getenv('TEMPORAL_NAMESPACE', '').strip()
TEMPORAL_ADDRESS = os.getenv('TEMPORAL_ADDRESS', '').strip()
TEMPORAL_API_KEY = os.getenv('TEMPORAL_API_KEY', '').strip()
ARCHIVE_DIRS_RAW = os.getenv('ARCHIVE_DIRS', r'C:\Users\USER\Downloads\Telegram Desktop').strip()
ARCHIVE_SCAN_MAX_FILES = max(1, int(os.getenv('ARCHIVE_SCAN_MAX_FILES', '5000')))
ARCHIVE_CACHE_TTL_SECONDS = max(10, int(os.getenv('ARCHIVE_CACHE_TTL_SECONDS', '180')))
ARCHIVE_METADATA_CACHE_FILE = Path(os.getenv('ARCHIVE_METADATA_CACHE_FILE', str(WORK_DIR / 'archive-metadata-cache.json'))).resolve()
ARCHIVE_AUDIO_EXTENSIONS = {'.flac', '.wav', '.mp3', '.m4a', '.aac', '.ogg', '.opus', '.webm'}
ARCHIVE_IMAGE_EXTENSIONS = {'.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif'}
ARCHIVE_ALLOWED_FILE_EXTENSIONS = ARCHIVE_AUDIO_EXTENSIONS | ARCHIVE_IMAGE_EXTENSIONS

app = FastAPI(title='SoundDrop Downloader API', version='7.1.0')
WORKFLOW_STATE: dict[str, dict[str, Any]] = {}
WORKFLOW_FINGERPRINT_INDEX: dict[str, str] = {}
WORKFLOW_LOCK = threading.Lock()
ARCHIVE_CACHE: dict[str, Any] = {'items': [], 'created_at': 0.0}
ARCHIVE_PATH_INDEX: dict[str, Path] = {}
ARCHIVE_LOCK = threading.Lock()
YTDLP_COOKIE_CACHE: dict[str, str] = {}


def resolve_ytdlp_cookiefile() -> str | None:
  explicit = os.getenv('YTDLP_COOKIES_FILE', '').strip()
  if explicit:
    candidate = Path(explicit).expanduser()
    if candidate.exists() and candidate.is_file():
      return str(candidate)

  raw_text = os.getenv('YTDLP_COOKIES_TEXT', '')
  raw_base64 = os.getenv('YTDLP_COOKIES_BASE64', '').strip()
  if raw_base64:
    try:
      raw_text = base64.b64decode(raw_base64).decode('utf-8')
    except Exception:
      raw_text = ''

  if not raw_text.strip():
    return None

  digest = hashlib.sha256(raw_text.encode('utf-8')).hexdigest()
  cached = YTDLP_COOKIE_CACHE.get(digest)
  if cached and Path(cached).exists():
    return cached

  target = WORK_DIR / f'yt-dlp-cookies-{digest[:16]}.txt'
  target.parent.mkdir(parents=True, exist_ok=True)
  target.write_text(raw_text.replace('\r\n', '\n'), encoding='utf-8')
  try:
    target.chmod(0o600)
  except OSError:
    pass
  YTDLP_COOKIE_CACHE.clear()
  YTDLP_COOKIE_CACHE[digest] = str(target)
  return str(target)


def apply_ytdlp_cookiefile(opts: dict[str, Any]) -> dict[str, Any]:
  cookiefile = resolve_ytdlp_cookiefile()
  if cookiefile:
    opts['cookiefile'] = cookiefile
  return opts


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
  parent_job_id: str | None = None
  variant_role: str | None = None
  sync_key: str | None = None
  playlist_folder: str | None = None
  playlist_index: int | None = None
  local_relpath: str | None = None


class SmokeRequest(BaseModel):
  url: str = Field(min_length=5, max_length=2000)
  source: str = 'unknown'
  format: str = 'mp3'
  quality: str = 'best'


class PreviewRequest(BaseModel):
  query: str = Field(min_length=1, max_length=2000)
  source: str = 'unknown'


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


class SmokeResponse(BaseModel):
  ok: bool
  source: str
  resolved_url: str
  fallback_used: bool
  title: str
  artist: str
  duration: int


class PreviewResponse(BaseModel):
  title: str
  artist: str
  duration: int
  thumbnail: str | None = None
  preview_url: str
  source: str
  resolved_url: str
  fallback_used: bool = False


class MetadataLookupRequest(BaseModel):
  query: str = Field(min_length=1, max_length=300)
  limit: int = Field(default=6, ge=1, le=10)


class MetadataLookupItem(BaseModel):
  id: str
  title: str
  artist: str
  album: str | None = None
  release_date: str | None = None
  year: str | None = None
  country: str | None = None
  type: str | None = None
  duration: int = 0
  score: int = 0


class MetadataLookupResponse(BaseModel):
  results: list[MetadataLookupItem]


class ArtistDiscographyRequest(BaseModel):
  artist: str = Field(min_length=1, max_length=200)
  source: str = 'youtube'
  limit: int = Field(default=50, ge=1, le=200)


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


class PlaylistWorkflowStartRequest(BaseModel):
  workflow_id: str | None = None
  url: str = Field(min_length=5, max_length=2000)
  source: str = 'unknown'
  format: str = 'mp3'
  quality: str = '320'
  batch_size: int | None = Field(default=None, ge=1, le=200)


class PlaylistWorkflowStatus(BaseModel):
  workflow_id: str
  status: str
  phase: str
  control_state: str = 'active'
  source_url: str
  source: str
  format: str
  quality: str
  total_tracks: int
  queued_count: int
  processing_count: int
  done_count: int
  failed_count: int
  deduped_count: int
  current_batch: int
  total_batches: int
  batch_size: int
  archive_status: str | None = None
  archive_url: str | None = None
  error: str | None = None
  archive_error: str | None = None
  temporal: dict[str, Any] | None = None
  created_at: str
  updated_at: str
  finished_at: str | None = None


class PlaylistZipFile(BaseModel):
  job_id: str = Field(min_length=1, max_length=100)
  title: str = Field(min_length=1, max_length=400)
  artist: str = Field(min_length=1, max_length=400)
  format: str = Field(min_length=1, max_length=16)
  download_url: str = Field(min_length=10, max_length=4000)


class PlaylistZipRequest(BaseModel):
  workflow_id: str = Field(min_length=8, max_length=100)
  source: str = 'unknown'
  files: list[PlaylistZipFile]


class PlaylistZipResponse(BaseModel):
  download_url: str
  filename: str
  file_size: int
  file_count: int


class ArchiveTrack(BaseModel):
  id: str
  title: str
  artist: str
  album: str | None = None
  duration: int = 0
  bpm: str | None = None
  released_year: str | None = None
  release_date: str | None = None
  format: str
  codec: str | None = None
  sample_rate: int | None = None
  bit_depth: int | None = None
  bit_rate: int | None = None
  channels: int | None = None
  size_bytes: int
  quality: str
  filename: str
  modified_at: str
  stream_url: str


class ArchiveResponse(BaseModel):
  tracks: list[ArchiveTrack]
  total: int
  limit: int
  offset: int


class ArchiveBrowseItem(BaseModel):
  id: str
  kind: str
  name: str
  relative_path: str
  title: str | None = None
  artist: str | None = None
  album: str | None = None
  duration: int = 0
  bpm: str | None = None
  released_year: str | None = None
  release_date: str | None = None
  format: str | None = None
  codec: str | None = None
  sample_rate: int | None = None
  bit_depth: int | None = None
  bit_rate: int | None = None
  channels: int | None = None
  size_bytes: int = 0
  quality: str | None = None
  modified_at: str | None = None
  stream_url: str | None = None


class ArchiveBrowseResponse(BaseModel):
  items: list[ArchiveBrowseItem]
  total: int
  limit: int
  offset: int
  path: str
  parent_path: str | None = None


def require_api_key(x_api_key: str | None = Header(default=None, alias='X-API-Key')) -> None:
  if x_api_key != API_KEY:
    raise HTTPException(status_code=401, detail='Invalid API key')


def archive_dirs() -> list[Path]:
  candidates = [part.strip().strip('"') for part in re.split(r'[;\n]', ARCHIVE_DIRS_RAW) if part.strip()]
  dirs: list[Path] = []
  for candidate in candidates:
    try:
      path = Path(candidate).expanduser().resolve()
    except Exception:
      continue
    if path.exists() and path.is_dir():
      dirs.append(path)
  return dirs


def safe_archive_relative(raw: str) -> Path:
  normalized = str(raw or '').replace('\\', '/').strip().strip('/')
  if not normalized:
    return Path()
  parts = [part for part in normalized.split('/') if part and part not in {'.'}]
  if any(part == '..' for part in parts):
    raise HTTPException(status_code=400, detail='Invalid archive path')
  return Path(*parts)


def archive_relative_string(path: Path) -> str:
  return '/'.join(path.parts).replace('\\', '/').strip('/')


def archive_child_relative(root: Path, child: Path) -> str:
  try:
    return child.resolve().relative_to(root.resolve()).as_posix()
  except Exception:
    return child.name


def archive_parent_path(raw_path: str) -> str | None:
  rel = safe_archive_relative(raw_path)
  if not rel.parts:
    return None
  return archive_relative_string(Path(*rel.parts[:-1]))


def archive_file_id(path: Path) -> str:
  return hashlib.sha256(str(path.resolve()).encode('utf-8', errors='ignore')).hexdigest()


def archive_cache_key(path: Path) -> str:
  stat = path.stat()
  return f'{path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}'


def archive_model_dump(track: ArchiveTrack) -> dict[str, Any]:
  if hasattr(track, 'model_dump'):
    return track.model_dump()
  return track.dict()


def load_archive_disk_cache() -> dict[str, dict[str, Any]]:
  try:
    raw = json.loads(ARCHIVE_METADATA_CACHE_FILE.read_text(encoding='utf-8'))
  except Exception:
    return {}
  if not isinstance(raw, dict):
    return {}
  rows = raw.get('tracks')
  if not isinstance(rows, dict):
    return {}
  return {str(key): value for key, value in rows.items() if isinstance(value, dict)}


def save_archive_disk_cache(rows: dict[str, dict[str, Any]]) -> None:
  try:
    ARCHIVE_METADATA_CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = ARCHIVE_METADATA_CACHE_FILE.with_suffix('.tmp')
    tmp_path.write_text(
      json.dumps({'version': 1, 'created_at': utc_now_iso(), 'tracks': rows}, ensure_ascii=False),
      encoding='utf-8',
    )
    tmp_path.replace(ARCHIVE_METADATA_CACHE_FILE)
  except Exception:
    return


def archive_track_from_cache(data: dict[str, Any]) -> ArchiveTrack | None:
  try:
    return ArchiveTrack(**data)
  except Exception:
    return None


def parse_filename_metadata(path: Path) -> tuple[str, str]:
  stem = re.sub(r'^\d+[\s._-]+', '', path.stem).strip()
  if ' - ' in stem:
    title, artist = stem.rsplit(' - ', 1)
    return title.strip() or stem, artist.strip() or 'Unknown Artist'
  return stem or path.name, 'Unknown Artist'


def ffprobe_metadata(path: Path) -> dict[str, Any]:
  try:
    result = subprocess.run(
      [
        'ffprobe',
        '-v',
        'error',
        '-show_format',
        '-show_streams',
        '-print_format',
        'json',
        str(path),
      ],
      capture_output=True,
      text=True,
      timeout=12,
      check=False,
    )
    if result.returncode != 0 or not result.stdout.strip():
      return {}
    payload = json.loads(result.stdout)
    return payload if isinstance(payload, dict) else {}
  except Exception:
    return {}


def normalized_tags(metadata: dict[str, Any]) -> dict[str, str]:
  merged: dict[str, str] = {}
  format_tags = metadata.get('format', {}).get('tags', {}) if isinstance(metadata.get('format'), dict) else {}
  if isinstance(format_tags, dict):
    for key, value in format_tags.items():
      merged[str(key).lower()] = str(value)
  streams = metadata.get('streams')
  if isinstance(streams, list):
    for stream in streams:
      if not isinstance(stream, dict):
        continue
      tags = stream.get('tags')
      if not isinstance(tags, dict):
        continue
      for key, value in tags.items():
        merged.setdefault(str(key).lower(), str(value))
  return merged


def first_tag(tags: dict[str, str], *names: str) -> str:
  for name in names:
    value = tags.get(name.lower())
    if value and value.strip():
      return value.strip()
  return ''


def parse_year(raw: str) -> str | None:
  if not raw:
    return None
  match = re.search(r'(19|20)\d{2}', raw)
  return match.group(0) if match else None


def parse_int(raw: Any) -> int | None:
  try:
    if raw is None or raw == '':
      return None
    value = int(float(str(raw)))
    return value if value >= 0 else None
  except Exception:
    return None


def audio_stream(metadata: dict[str, Any]) -> dict[str, Any]:
  streams = metadata.get('streams')
  if isinstance(streams, list):
    for stream in streams:
      if isinstance(stream, dict) and stream.get('codec_type') == 'audio':
        return stream
  return {}


def quality_label(path: Path, stream: dict[str, Any], bit_rate: int | None) -> str:
  ext = path.suffix.lower()
  if ext in {'.flac', '.wav'}:
    bit_depth = parse_int(stream.get('bits_per_raw_sample') or stream.get('bits_per_sample'))
    sample_rate = parse_int(stream.get('sample_rate'))
    if bit_depth and sample_rate:
      return f'Lossless {sample_rate // 1000}kHz/{bit_depth}-bit'
    return 'Lossless'
  if bit_rate:
    return f'{max(1, round(bit_rate / 1000))} kbps'
  return 'Audio'


def archive_track_from_path(path: Path) -> ArchiveTrack:
  metadata = ffprobe_metadata(path)
  tags = normalized_tags(metadata)
  stream = audio_stream(metadata)
  title_from_name, artist_from_name = parse_filename_metadata(path)
  format_info = metadata.get('format', {}) if isinstance(metadata.get('format'), dict) else {}
  stat = path.stat()
  duration = parse_int(format_info.get('duration') or stream.get('duration')) or 0
  bit_rate = parse_int(format_info.get('bit_rate') or stream.get('bit_rate'))
  sample_rate = parse_int(stream.get('sample_rate'))
  channels = parse_int(stream.get('channels'))
  bit_depth = parse_int(stream.get('bits_per_raw_sample') or stream.get('bits_per_sample'))
  release_date = first_tag(tags, 'date', 'releasedate', 'release_date', 'year', 'originaldate')
  bpm = first_tag(tags, 'bpm', 'tbpm', 'tempo')
  track_id = archive_file_id(path)
  title = first_tag(tags, 'title') or title_from_name
  artist = first_tag(tags, 'artist', 'album_artist', 'albumartist', 'composer') or artist_from_name

  return ArchiveTrack(
    id=track_id,
    title=title,
    artist=artist,
    album=first_tag(tags, 'album') or None,
    duration=duration,
    bpm=bpm or None,
    released_year=parse_year(release_date) or parse_year(path.name),
    release_date=release_date or None,
    format=path.suffix.replace('.', '').upper() or 'AUDIO',
    codec=str(stream.get('codec_name') or format_info.get('format_name') or '').upper() or None,
    sample_rate=sample_rate,
    bit_depth=bit_depth,
    bit_rate=bit_rate,
    channels=channels,
    size_bytes=stat.st_size,
    quality=quality_label(path, stream, bit_rate),
    filename=path.name,
    modified_at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(stat.st_mtime)),
    stream_url=f'{PUBLIC_BASE_URL}/internal/archive/files/{track_id}',
  )


def archive_item_from_path(root: Path, path: Path) -> ArchiveBrowseItem | None:
  resolved = path.resolve()
  relative_path = archive_child_relative(root, resolved)
  stat = resolved.stat()
  modified_at = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(stat.st_mtime))
  if resolved.is_dir():
    return ArchiveBrowseItem(
      id=archive_file_id(resolved),
      kind='folder',
      name=resolved.name,
      relative_path=relative_path,
      modified_at=modified_at,
    )

  suffix = resolved.suffix.lower()
  if suffix in ARCHIVE_AUDIO_EXTENSIONS:
    track = archive_track_from_path(resolved)
    return ArchiveBrowseItem(
      id=track.id,
      kind='audio',
      name=resolved.name,
      relative_path=relative_path,
      title=track.title,
      artist=track.artist,
      album=track.album,
      duration=track.duration,
      bpm=track.bpm,
      released_year=track.released_year,
      release_date=track.release_date,
      format=track.format,
      codec=track.codec,
      sample_rate=track.sample_rate,
      bit_depth=track.bit_depth,
      bit_rate=track.bit_rate,
      channels=track.channels,
      size_bytes=track.size_bytes,
      quality=track.quality,
      modified_at=track.modified_at,
      stream_url=track.stream_url,
    )

  if suffix in ARCHIVE_IMAGE_EXTENSIONS:
    return ArchiveBrowseItem(
      id=archive_file_id(resolved),
      kind='image',
      name=resolved.name,
      relative_path=relative_path,
      title=resolved.stem,
      format=suffix.replace('.', '').upper(),
      size_bytes=stat.st_size,
      modified_at=modified_at,
      stream_url=f'{PUBLIC_BASE_URL}/internal/archive/files/{archive_file_id(resolved)}',
    )

  return None


def browse_archive_items(path: str, query: str = '', limit: int = 120, offset: int = 0) -> tuple[list[ArchiveBrowseItem], int]:
  roots = archive_dirs()
  requested = safe_archive_relative(path)
  entries: list[tuple[int, str, Path, Path]] = []
  q = str(query or '').strip().lower()
  tokens = [part for part in re.split(r'\s+', q) if part]

  for root in roots:
    base = (root / requested).resolve()
    try:
      base.relative_to(root.resolve())
    except Exception:
      continue
    if not base.exists() or not base.is_dir():
      continue

    try:
      children = list(base.iterdir())
    except Exception:
      continue

    for child in children:
      try:
        is_dir = child.is_dir()
        suffix = child.suffix.lower()
        if child.is_file() and suffix not in ARCHIVE_ALLOWED_FILE_EXTENSIONS:
          continue
        kind = 0 if is_dir else 1 if suffix in ARCHIVE_AUDIO_EXTENSIONS else 2
        relative_path = archive_child_relative(root, child)
        if tokens:
          haystack = ' '.join([
            child.name,
            child.stem,
            suffix.replace('.', ''),
            'folder' if is_dir else 'audio' if suffix in ARCHIVE_AUDIO_EXTENSIONS else 'image',
            relative_path,
          ]).lower()
          if not all(token in haystack for token in tokens):
            continue
        entries.append((kind, child.name.lower(), root, child))
      except Exception:
        continue

  entries.sort(key=lambda item: (item[0], item[1]))
  total = len(entries)
  page_entries = entries[max(0, offset):max(0, offset) + max(1, limit)]
  items: list[ArchiveBrowseItem] = []
  for _, _, root, child in page_entries:
    try:
      item = archive_item_from_path(root, child)
      if item is not None:
        items.append(item)
    except Exception:
      continue
  return items, total


def scan_archive_tracks(force: bool = False) -> list[ArchiveTrack]:
  now = time.time()
  with ARCHIVE_LOCK:
    cached_items = ARCHIVE_CACHE.get('items')
    cached_at = float(ARCHIVE_CACHE.get('created_at') or 0)
    if not force and isinstance(cached_items, list) and now - cached_at < ARCHIVE_CACHE_TTL_SECONDS:
      return list(cached_items)

  paths: list[Path] = []
  for root in archive_dirs():
    try:
      for path in root.rglob('*'):
        if len(paths) >= ARCHIVE_SCAN_MAX_FILES:
          break
        if path.is_file() and path.suffix.lower() in ARCHIVE_AUDIO_EXTENSIONS:
          paths.append(path.resolve())
    except Exception:
      continue

  paths.sort(key=lambda item: item.stat().st_mtime if item.exists() else 0, reverse=True)
  disk_cache = load_archive_disk_cache()
  next_disk_cache: dict[str, dict[str, Any]] = {}
  path_index: dict[str, Path] = {}
  items: list[ArchiveTrack] = []
  for path in paths[:ARCHIVE_SCAN_MAX_FILES]:
    try:
      cache_key = archive_cache_key(path)
      track = archive_track_from_cache(disk_cache.get(cache_key, {}))
      if track is None:
        track = archive_track_from_path(path)
      items.append(track)
      path_index[track.id] = path
      next_disk_cache[cache_key] = archive_model_dump(track)
    except Exception:
      continue

  if next_disk_cache:
    save_archive_disk_cache(next_disk_cache)

  with ARCHIVE_LOCK:
    ARCHIVE_CACHE['items'] = list(items)
    ARCHIVE_CACHE['created_at'] = now
    ARCHIVE_PATH_INDEX.clear()
    ARCHIVE_PATH_INDEX.update(path_index)
  return items


def find_archive_path(file_id: str) -> Path | None:
  wanted = str(file_id or '').strip().lower()
  if not re.fullmatch(r'[a-f0-9]{64}', wanted):
    return None
  with ARCHIVE_LOCK:
    cached_path = ARCHIVE_PATH_INDEX.get(wanted)
  if cached_path and cached_path.exists() and cached_path.is_file():
    return cached_path

  # Populate the index first; this uses disk metadata cache after the first scan.
  try:
    scan_archive_tracks(force=False)
    with ARCHIVE_LOCK:
      cached_path = ARCHIVE_PATH_INDEX.get(wanted)
    if cached_path and cached_path.exists() and cached_path.is_file():
      return cached_path
  except Exception:
    pass

  for root in archive_dirs():
    try:
      for path in root.rglob('*'):
        if path.is_file() and path.suffix.lower() in ARCHIVE_ALLOWED_FILE_EXTENSIONS:
          resolved = path.resolve()
          if archive_file_id(resolved) == wanted:
            return resolved
    except Exception:
      continue
  return None


def utc_now_iso() -> str:
  return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())


def normalize_audio_format(raw: str) -> str:
  value = (raw or 'mp3').strip().lower()
  return value if value in SUPPORTED_FORMATS else 'mp3'


def normalize_audio_quality(raw: str, audio_format: str) -> str:
  value = (raw or '320').strip().lower()
  if audio_format in {'flac', 'wav'}:
    return value if value in {'lossless', 'best'} else 'lossless'
  return value if value in SUPPORTED_QUALITIES else '320'


def workflow_fingerprint(url: str, source: str, audio_format: str, audio_quality: str) -> str:
  canonical = f'{url.strip()}|{source.strip().lower()}|{audio_format}|{audio_quality}'
  return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def track_fingerprint(url: str, audio_format: str, audio_quality: str) -> str:
  canonical = f'{url.strip()}|{audio_format}|{audio_quality}'
  return hashlib.sha256(canonical.encode('utf-8')).hexdigest()


def cleanup_workflow_state() -> None:
  cutoff = time.time() - PLAYLIST_WORKFLOW_RETENTION_SECONDS
  remove_ids: list[str] = []

  for workflow_id, state in WORKFLOW_STATE.items():
    finished_at = state.get('finished_at')
    updated_at = state.get('updated_at')
    candidate_raw = finished_at or updated_at
    if not isinstance(candidate_raw, str):
      continue
    try:
      candidate_ts = calendar.timegm(time.strptime(candidate_raw, '%Y-%m-%dT%H:%M:%SZ'))
    except Exception:
      continue
    if candidate_ts < cutoff:
      remove_ids.append(workflow_id)

  for workflow_id in remove_ids:
    state = WORKFLOW_STATE.pop(workflow_id, None)
    if not state:
      continue
    fingerprint = str(state.get('fingerprint') or '')
    if fingerprint:
      existing = WORKFLOW_FINGERPRINT_INDEX.get(fingerprint)
      if existing == workflow_id:
        WORKFLOW_FINGERPRINT_INDEX.pop(fingerprint, None)


def get_workflow_state(workflow_id: str) -> dict[str, Any] | None:
  with WORKFLOW_LOCK:
    cleanup_workflow_state()
    state = WORKFLOW_STATE.get(workflow_id)
    if not state:
      return None
    return dict(state)


def save_workflow_state(workflow_id: str, state: dict[str, Any]) -> None:
  with WORKFLOW_LOCK:
    state['updated_at'] = utc_now_iso()
    WORKFLOW_STATE[workflow_id] = dict(state)
    fingerprint = str(state.get('fingerprint') or '')
    if fingerprint:
      WORKFLOW_FINGERPRINT_INDEX[fingerprint] = workflow_id
    cleanup_workflow_state()


def update_workflow_state(workflow_id: str, **patch: Any) -> dict[str, Any] | None:
  with WORKFLOW_LOCK:
    current = WORKFLOW_STATE.get(workflow_id)
    if not current:
      return None
    merged = dict(current)
    merged.update(patch)
    merged['updated_at'] = utc_now_iso()
    WORKFLOW_STATE[workflow_id] = merged
    cleanup_workflow_state()
    return dict(merged)


def initial_workflow_state(
  workflow_id: str,
  fingerprint: str,
  payload: PlaylistWorkflowStartRequest,
  detected_source: str,
  audio_format: str,
  audio_quality: str,
  batch_size: int,
) -> dict[str, Any]:
  now = utc_now_iso()
  return {
    'workflow_id': workflow_id,
    'fingerprint': fingerprint,
    'status': 'queued',
    'phase': 'submitted',
    'control_state': 'active',
    'source_url': payload.url.strip(),
    'source': detected_source,
    'format': audio_format,
    'quality': audio_quality,
    'total_tracks': 0,
    'queued_count': 0,
    'processing_count': 0,
    'done_count': 0,
    'failed_count': 0,
    'deduped_count': 0,
    'current_batch': 0,
    'total_batches': 0,
    'batch_size': batch_size,
    'archive_status': None,
    'archive_url': None,
    'archive_error': None,
    'error': None,
    'temporal': {
      'enabled': bool(TEMPORAL_NAMESPACE and TEMPORAL_ADDRESS),
      'connected': False,
      'namespace': TEMPORAL_NAMESPACE or None,
      'address': TEMPORAL_ADDRESS or None,
      'mode': 'local',
      'reason': None,
    },
    'created_at': now,
    'updated_at': now,
    'finished_at': None,
  }


def maybe_mark_temporal_mode(workflow_id: str) -> None:
  if not TEMPORAL_NAMESPACE or not TEMPORAL_ADDRESS:
    update_workflow_state(
      workflow_id,
      temporal={
        'enabled': False,
        'connected': False,
        'namespace': None,
        'address': None,
        'mode': 'local',
        'reason': 'TEMPORAL_NOT_CONFIGURED',
      },
    )
    return

  try:
    import importlib.util
    has_sdk = importlib.util.find_spec('temporalio') is not None
    if not has_sdk:
      update_workflow_state(
        workflow_id,
        temporal={
          'enabled': True,
          'connected': False,
          'namespace': TEMPORAL_NAMESPACE,
          'address': TEMPORAL_ADDRESS,
          'mode': 'local',
          'reason': 'TEMPORAL_SDK_MISSING',
        },
      )
      return
    update_workflow_state(
      workflow_id,
      temporal={
        'enabled': True,
        'connected': False,
        'namespace': TEMPORAL_NAMESPACE,
        'address': TEMPORAL_ADDRESS,
        'mode': 'local',
        'reason': 'TEMPORAL_BRIDGE_NOT_ENABLED',
      },
    )
  except Exception as error:
    update_workflow_state(
      workflow_id,
      temporal={
        'enabled': True,
        'connected': False,
        'namespace': TEMPORAL_NAMESPACE,
        'address': TEMPORAL_ADDRESS,
        'mode': 'local',
        'reason': f'TEMPORAL_CHECK_FAILED:{error}',
      },
    )


def run_playlist_workflow_local(workflow_id: str) -> None:
  state = get_workflow_state(workflow_id)
  if not state:
    return

  source_url = str(state.get('source_url') or '')
  source = str(state.get('source') or 'unknown')
  audio_format = str(state.get('format') or 'mp3')
  audio_quality = str(state.get('quality') or '320')
  batch_size = int(state.get('batch_size') or PLAYLIST_WORKFLOW_BATCH_SIZE)

  update_workflow_state(workflow_id, status='processing', phase='resolving')
  maybe_mark_temporal_mode(workflow_id)

  try:
    resolved = resolve_playlist(source_url, source)
  except Exception as error:
    update_workflow_state(
      workflow_id,
      status='failed',
      phase='failed',
      error=f'Playlist resolve failed: {error}',
      finished_at=utc_now_iso(),
      processing_count=0,
    )
    return

  tracks = resolved.tracks if isinstance(resolved.tracks, list) else []
  total_tracks = len(tracks)
  if total_tracks == 0:
    update_workflow_state(
      workflow_id,
      status='failed',
      phase='failed',
      error='Playlist contains no tracks.',
      finished_at=utc_now_iso(),
      total_tracks=0,
      processing_count=0,
    )
    return

  total_batches = (total_tracks + batch_size - 1) // batch_size
  update_workflow_state(
    workflow_id,
    total_tracks=total_tracks,
    total_batches=total_batches,
    processing_count=0,
  )

  seen_fingerprints: set[str] = set()
  queued_count = 0
  done_count = 0
  failed_count = 0
  deduped_count = 0

  for batch_index in range(total_batches):
    latest = get_workflow_state(workflow_id)
    control_state = str((latest or {}).get('control_state') or 'active').lower()
    if control_state == 'cancelled':
      update_workflow_state(
        workflow_id,
        status='failed',
        phase='cancelled',
        error='Cancelled by user',
        processing_count=0,
        finished_at=utc_now_iso(),
      )
      return
    if control_state == 'paused':
      update_workflow_state(
        workflow_id,
        status='queued',
        phase='paused',
        processing_count=0,
      )
      return

    start = batch_index * batch_size
    end = min(total_tracks, start + batch_size)
    batch = tracks[start:end]

    update_workflow_state(
      workflow_id,
      phase='enqueueing',
      current_batch=batch_index + 1,
      processing_count=max(0, end - start),
      queued_count=queued_count,
      done_count=done_count,
      failed_count=failed_count,
      deduped_count=deduped_count,
    )

    for track in batch:
      if not isinstance(track, PlaylistTrack):
        failed_count += 1
        continue

      candidate_url = track.url.strip()
      if not is_url(candidate_url):
        failed_count += 1
        continue

      fp = track_fingerprint(candidate_url, audio_format, audio_quality)
      if fp in seen_fingerprints:
        deduped_count += 1
        continue

      seen_fingerprints.add(fp)
      queued_count += 1
      done_count += 1

    update_workflow_state(
      workflow_id,
      phase='batch_completed',
      current_batch=batch_index + 1,
      queued_count=queued_count,
      done_count=done_count,
      failed_count=failed_count,
      deduped_count=deduped_count,
      processing_count=0,
    )

  final_status = 'done' if done_count > 0 else 'failed'
  final_error = None if final_status == 'done' else 'No tracks could be queued.'
  update_workflow_state(
    workflow_id,
    status=final_status,
    phase='finalized' if final_status == 'done' else 'failed',
    queued_count=queued_count,
    done_count=done_count,
    failed_count=failed_count,
    deduped_count=deduped_count,
    processing_count=0,
    error=final_error,
    finished_at=utc_now_iso(),
  )


def is_url(value: str) -> bool:
  try:
    from urllib.parse import urlparse

    parsed = urlparse(value)
    return parsed.scheme in {'http', 'https'}
  except Exception:
    return False


def is_ytdlp_search_target(value: str) -> bool:
  return re.match(r'^ytsearch[0-9]{0,2}:.{2,300}$', str(value or '').strip(), flags=re.I) is not None


def is_download_target(value: str) -> bool:
  return is_url(value) or is_ytdlp_search_target(value)


def detect_source(url: str, fallback: str = 'unknown') -> str:
  lower = url.lower()
  if lower.startswith('ytsearch'):
    return 'youtube'
  if 'youtube.com' in lower or 'youtu.be' in lower or 'music.youtube.com' in lower:
    return 'youtube'
  if 'spotify.com' in lower:
    if '/show/' in lower or '/episode/' in lower:
      return 'podcast'
    return 'spotify'
  if 'podcasts.apple.com' in lower:
    return 'podcast'
  if 'soundcloud.com' in lower:
    return 'soundcloud'
  if 'deezer.com' in lower:
    return 'deezer'
  if 'music.apple.com' in lower or 'itunes.apple.com' in lower:
    if '/podcast/' in lower or 'podcast' in lower:
      return 'podcast'
    return 'apple'
  if '/feed' in lower or 'rss' in lower or lower.endswith('.xml'):
    return 'podcast'
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
  if 'podcasts.apple.com' in host:
    return True
  if host.endswith('spotify.com') and '/show/' in path:
    return True
  if path.endswith('.xml') or '/feed' in path or 'rss' in path:
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


def extract_spotify_show_id(raw_url: str) -> str | None:
  match = re.search(r'spotify\.com/show/([a-zA-Z0-9]+)', raw_url)
  return match.group(1) if match else None


def extract_apple_podcast_id(raw_url: str) -> str | None:
  match = re.search(r'id([0-9]{4,})', raw_url)
  return match.group(1) if match else None


def is_rss_feed_url(raw_url: str) -> bool:
  try:
    parsed = urllib.parse.urlparse(raw_url)
  except Exception:
    return False
  path = parsed.path.lower()
  query = parsed.query.lower()
  return path.endswith(('.xml', '.rss', '.atom')) or '/feed' in path or 'rss' in path or 'feed=' in query


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


def xml_local_name(tag: str) -> str:
  return str(tag or '').split('}', 1)[-1].lower()


def direct_child_text(element: ET.Element, names: set[str]) -> str:
  for child in list(element):
    if xml_local_name(child.tag) in names and child.text:
      return html.unescape(child.text).strip()
  return ''


def direct_child_attr(element: ET.Element, name: str, attr: str) -> str:
  for child in list(element):
    if xml_local_name(child.tag) == name:
      value = str(child.attrib.get(attr) or '').strip()
      if value:
        return value
  return ''


def atom_link_url(entry: ET.Element) -> str:
  fallback = ''
  for child in list(entry):
    if xml_local_name(child.tag) != 'link':
      continue
    href = str(child.attrib.get('href') or '').strip()
    if not href:
      continue
    rel = str(child.attrib.get('rel') or 'alternate').lower()
    if rel == 'enclosure':
      return href
    if not fallback and rel in {'alternate', 'related'}:
      fallback = href
  return fallback


def resolve_rss_feed(url: str) -> PlaylistResolveResponse:
  raw_xml = fetch_text(
    url,
    timeout_seconds=25,
    headers={'Accept': 'application/rss+xml,application/atom+xml,application/xml,text/xml,*/*'},
  )
  root = ET.fromstring(raw_xml)
  root_name = xml_local_name(root.tag)
  tracks: list[PlaylistTrack] = []

  if root_name == 'feed':
    feed_title = direct_child_text(root, {'title'}) or 'Podcast Feed'
    for index, entry in enumerate([child for child in list(root) if xml_local_name(child.tag) == 'entry'], start=1):
      episode_url = atom_link_url(entry)
      if not episode_url:
        continue
      title = direct_child_text(entry, {'title'}) or f'Episode {index}'
      author = direct_child_text(entry, {'author', 'creator', 'name'}) or feed_title
      tracks.append(PlaylistTrack(title=title, artist=author, source='podcast', url=episode_url))
    return PlaylistResolveResponse(title=feed_title, source='podcast', total=len(tracks), tracks=tracks)

  channel = root.find('channel')
  if channel is None:
    channel = root

  feed_title = direct_child_text(channel, {'title'}) or 'Podcast Feed'
  items = [child for child in list(channel) if xml_local_name(child.tag) == 'item']
  for index, item in enumerate(items, start=1):
    episode_url = direct_child_attr(item, 'enclosure', 'url') or direct_child_text(item, {'link', 'guid'})
    if not episode_url or not episode_url.startswith(('http://', 'https://')):
      continue
    title = direct_child_text(item, {'title'}) or f'Episode {index}'
    artist = direct_child_text(item, {'author', 'creator'}) or feed_title
    tracks.append(PlaylistTrack(title=title, artist=artist, source='podcast', url=episode_url))

  return PlaylistResolveResponse(title=feed_title, source='podcast', total=len(tracks), tracks=tracks)


def get_spotify_access_token() -> str:
  web_token_error: Exception | None = None
  try:
    payload = fetch_json(
      'https://open.spotify.com/get_access_token?reason=transport&productType=web_player',
      timeout_seconds=20,
    )
    if isinstance(payload, dict):
      token = str(payload.get('accessToken') or '').strip()
      if token:
        return token
    web_token_error = RuntimeError('Spotify web token response did not contain accessToken')
  except Exception as error:
    web_token_error = error

  if not SPOTIFY_CLIENT_ID or not SPOTIFY_CLIENT_SECRET:
    reason = str(web_token_error) if web_token_error else 'unknown error'
    raise RuntimeError(
      'Spotify playlist extraction needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET. '
      f'Anonymous token endpoint failed: {reason}',
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
  opts = apply_ytdlp_cookiefile(opts)

  with YoutubeDL(opts) as ydl:
    raw = ydl.extract_info(search_query, download=False)

  items: list[SearchItem] = []
  for entry in extract_entries(raw):
    normalized = normalize_item(entry, 'all')
    if normalized:
      items.append(normalized)

  return items[:limit]


def extract_preview_info(query: str, source: str = 'unknown') -> PreviewResponse:
  target = query.strip()
  if not target:
    raise RuntimeError('Preview query is empty')

  fallback_used = False
  detected_source = detect_source(target, source) if is_url(target) else 'youtube'

  if is_url(target) and detected_source in FALLBACK_SOURCES:
    title, artist = extract_track_metadata(target)
    target = find_youtube_mirror_url(title, artist)
    detected_source = 'youtube'
    fallback_used = True

  search_target = target if is_url(target) else f'ytsearch1:{target}'
  opts = {
    'quiet': True,
    'no_warnings': True,
    'skip_download': True,
    'noplaylist': True,
    'format': 'bestaudio/best',
    'default_search': 'auto',
    'ignoreerrors': True,
    'extractor_args': {
      'youtube': {
        'player_client': ['tv', 'ios', 'android'],
      },
    },
  }
  opts = apply_ytdlp_cookiefile(opts)

  with YoutubeDL(opts) as ydl:
    raw = ydl.extract_info(search_target, download=False)
    if not isinstance(raw, dict) and is_url(target):
      raw = ydl.extract_info(f'ytsearch1:{target}', download=False)

  if not isinstance(raw, dict):
    raise RuntimeError('Preview extractor returned no media')
  entries = extract_entries(raw)
  info = entries[0] if entries else raw
  if not isinstance(info, dict):
    raise RuntimeError('Preview extractor returned no media')

  preview_url = ''
  formats = info.get('formats')
  if isinstance(formats, list):
    audio_formats = [
      item for item in formats
      if (
        isinstance(item, dict)
        and str(item.get('url') or '').strip()
        and str(item.get('vcodec') or 'none') == 'none'
        and str(item.get('acodec') or 'none') != 'none'
        and str(item.get('ext') or '').lower() in {'m4a', 'mp3', 'webm', 'opus', 'ogg', 'flac', 'wav'}
      )
    ]
    audio_formats.sort(key=lambda item: int(item.get('abr') or item.get('tbr') or 0), reverse=True)
    if audio_formats:
      preview_url = str(audio_formats[0].get('url') or '').strip()
  if not preview_url:
    preview_url = str(info.get('url') or '').strip()
  if not preview_url:
    raise RuntimeError('Preview URL is unavailable')

  resolved_url = str(info.get('webpage_url') or info.get('original_url') or target).strip()
  title = str(info.get('title') or 'Preview').strip()
  artist = str(info.get('artist') or info.get('uploader') or info.get('channel') or 'Unknown Artist').strip()
  duration = parse_int(info.get('duration')) or 0
  thumbnail = str(info.get('thumbnail') or '').strip() or None

  return PreviewResponse(
    title=title,
    artist=artist,
    duration=duration,
    thumbnail=thumbnail,
    preview_url=preview_url,
    source=detect_source(resolved_url, detected_source),
    resolved_url=resolved_url,
    fallback_used=fallback_used,
  )


def lookup_musicbrainz_metadata(query: str, limit: int = 6) -> MetadataLookupResponse:
  safe_limit = max(1, min(10, int(limit or 6)))
  encoded_query = urllib.parse.quote(query.strip())
  payload = fetch_json(
    f'https://musicbrainz.org/ws/2/recording?query={encoded_query}&fmt=json&limit={safe_limit}',
    timeout_seconds=15,
    headers={
      'User-Agent': 'DyrakArmyDownloader/8.1 (https://dyrakarmy.online)',
    },
  )
  recordings = payload.get('recordings') if isinstance(payload, dict) else []
  if not isinstance(recordings, list):
    recordings = []

  results: list[MetadataLookupItem] = []
  for recording in recordings[:safe_limit]:
    if not isinstance(recording, dict):
      continue
    artist_credit = recording.get('artist-credit')
    artists: list[str] = []
    if isinstance(artist_credit, list):
      for credit in artist_credit:
        if isinstance(credit, dict):
          artist_obj = credit.get('artist')
          if isinstance(artist_obj, dict):
            name = str(artist_obj.get('name') or '').strip()
            if name:
              artists.append(name)

    releases = recording.get('releases')
    first_release = releases[0] if isinstance(releases, list) and releases and isinstance(releases[0], dict) else {}
    release_group = first_release.get('release-group') if isinstance(first_release, dict) else {}
    release_date = str(first_release.get('date') or recording.get('first-release-date') or '').strip() or None
    year = parse_year(release_date) if release_date else None
    length_ms = parse_int(recording.get('length')) or 0

    results.append(
      MetadataLookupItem(
        id=str(recording.get('id') or '').strip(),
        title=str(recording.get('title') or 'Unknown Title').strip(),
        artist=', '.join(artists) or 'Unknown Artist',
        album=str(first_release.get('title') or '').strip() or None,
        release_date=release_date,
        year=year,
        country=str(first_release.get('country') or '').strip() or None,
        type=str(release_group.get('primary-type') or '').strip() or None if isinstance(release_group, dict) else None,
        duration=round(length_ms / 1000) if length_ms else 0,
        score=parse_int(recording.get('score')) or 0,
      )
    )

  return MetadataLookupResponse(results=results)


def normalize_discography_search_text(value: str) -> str:
  return re.sub(r'\s+', ' ', str(value or '').replace('\r', ' ').replace('\n', ' ')).strip()


def ytdlp_search_target(artist: str, title: str) -> str:
  clean_artist = normalize_discography_search_text(artist)[:120] or 'Unknown Artist'
  clean_title = normalize_discography_search_text(title)[:160] or 'Unknown Title'
  return f'ytsearch1:{clean_artist} - {clean_title} audio'


def playlist_tracks_from_search_items(artist: str, items: list[SearchItem], limit: int) -> list[PlaylistTrack]:
  tracks: list[PlaylistTrack] = []
  seen: set[str] = set()
  for item in items:
    title = normalize_discography_search_text(item.title)
    track_artist = normalize_discography_search_text(item.artist) or artist
    url = str(item.url or '').strip()
    if not title or not url:
      continue
    key = f'{track_artist.lower()}::{title.lower()}'
    if key in seen:
      continue
    seen.add(key)
    tracks.append(
      PlaylistTrack(
        title=title,
        artist=track_artist,
        source=item.source or 'youtube',
        url=url if is_url(url) else ytdlp_search_target(track_artist, title),
      )
    )
    if len(tracks) >= limit:
      break
  return tracks


def lookup_artist_discography_with_ytdlp_search(artist: str, limit: int) -> list[PlaylistTrack]:
  safe_limit = max(1, min(20, int(limit or 20)))
  queries = [
    f'{artist} official audio',
    f'{artist} songs',
  ]
  combined: list[SearchItem] = []
  seen_urls: set[str] = set()
  last_error: Exception | None = None

  for query in queries:
    try:
      for item in make_ydl_search(query, safe_limit):
        if item.url in seen_urls:
          continue
        seen_urls.add(item.url)
        combined.append(item)
    except Exception as error:
      last_error = error
      continue
    if len(combined) >= safe_limit:
      break

  tracks = playlist_tracks_from_search_items(artist, combined, safe_limit)
  if tracks:
    return tracks
  if last_error:
    raise RuntimeError(f'Fallback search failed: {last_error}') from last_error
  return []


def lookup_artist_discography(artist: str, limit: int = 50) -> PlaylistResolveResponse:
  clean_artist = normalize_discography_search_text(artist)
  if len(clean_artist) < 2:
    raise RuntimeError('Artist name is required')

  safe_limit = max(1, min(200, int(limit or 50)))
  provider_error: Exception | None = None
  payload: Any = {}
  for attempt in range(2):
    try:
      encoded_query = urllib.parse.quote(f'artist:"{clean_artist}"')
      payload = fetch_json(
        f'https://musicbrainz.org/ws/2/recording?query={encoded_query}&fmt=json&limit={safe_limit}',
        timeout_seconds=20,
        headers={
          'User-Agent': 'DyrakArmyDownloader/8.1 (https://dyrakarmy.online)',
        },
      )
      provider_error = None
      break
    except Exception as error:
      provider_error = error
      if attempt == 0:
        time.sleep(0.8)

  recordings = payload.get('recordings') if isinstance(payload, dict) else []
  if not isinstance(recordings, list):
    recordings = []

  tracks: list[PlaylistTrack] = []
  seen_titles: set[str] = set()
  for recording in recordings:
    if not isinstance(recording, dict):
      continue
    title = normalize_discography_search_text(str(recording.get('title') or ''))
    if not title:
      continue
    key = title.lower()
    if key in seen_titles:
      continue
    seen_titles.add(key)

    artists: list[str] = []
    artist_credit = recording.get('artist-credit')
    if isinstance(artist_credit, list):
      for credit in artist_credit:
        if isinstance(credit, dict):
          artist_obj = credit.get('artist')
          if isinstance(artist_obj, dict):
            name = normalize_discography_search_text(str(artist_obj.get('name') or ''))
            if name:
              artists.append(name)
    track_artist = ', '.join(artists) or clean_artist
    tracks.append(
      PlaylistTrack(
        title=title,
        artist=track_artist,
        source='youtube',
        url=ytdlp_search_target(track_artist, title),
      )
    )
    if len(tracks) >= safe_limit:
      break

  if not tracks:
    fallback_limit = min(safe_limit, 20)
    tracks = lookup_artist_discography_with_ytdlp_search(clean_artist, fallback_limit)
    if not tracks and provider_error:
      raise RuntimeError(f'Metadata provider failed and fallback returned no tracks: {provider_error}') from provider_error

  return PlaylistResolveResponse(
    title=f'{clean_artist} Discography',
    source='artist',
    total=len(tracks),
    tracks=tracks,
  )


def choose_quality(requested_format: str, requested_quality: str) -> str:
  if requested_quality == 'lossless' or requested_format in {'flac', 'wav'}:
    return '0'
  if requested_quality == 'best':
    return '0'
  return requested_quality


def safe_job_dir_name(job_id: str) -> str:
  value = re.sub(r'[^a-zA-Z0-9._-]+', '-', str(job_id or '').strip())
  return value[:120] or f'job-{uuid.uuid4().hex[:12]}'


def quality_fallback_chain(audio_format: str, requested_quality: str) -> list[str]:
  normalized = normalize_audio_quality(requested_quality, audio_format)
  if audio_format in {'flac', 'wav'}:
    chain = [normalized, 'best', 'lossless']
  else:
    chain = [normalized, 'best', '320', '256', '192', '128']
  seen: set[str] = set()
  output: list[str] = []
  for item in chain:
    if item in SUPPORTED_QUALITIES and item not in seen:
      seen.add(item)
      output.append(item)
  return output or ['best']


def source_fallback_chain(url: str, requested_source: str) -> list[str]:
  initial = detect_source(url, requested_source)
  chain = [initial]
  if initial in FALLBACK_SOURCES:
    chain.extend(['youtube', 'all'])
  elif initial in {'unknown', 'all'}:
    chain.append('youtube')
  else:
    chain.append('all')
  seen: set[str] = set()
  output: list[str] = []
  for item in chain:
    normalized = (item or 'unknown').strip().lower()
    if normalized and normalized not in seen:
      seen.add(normalized)
      output.append(normalized)
  return output


def run_download(job_id: str, url: str, audio_format: str, audio_quality: str) -> tuple[Path, dict[str, Any]]:
  work_dir = WORK_DIR / safe_job_dir_name(job_id)
  work_dir.mkdir(parents=True, exist_ok=True)
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
    'continuedl': True,
    'retries': 10,
    'fragment_retries': 10,
    'file_access_retries': 5,
    'extractor_retries': 3,
    'outtmpl': output_template,
    'postprocessors': [
      {
        'key': 'FFmpegExtractAudio',
        'preferredcodec': audio_format,
        'preferredquality': audio_quality,
      },
    ],
  }
  ydl_opts = apply_ytdlp_cookiefile(ydl_opts)

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
    # Keep partial files in work dir so subsequent retries can resume.
    raise


def probe_download_metadata(url: str) -> dict[str, Any]:
  opts = {
    'quiet': True,
    'no_warnings': True,
    'skip_download': True,
    'noplaylist': True,
    'ignoreerrors': False,
    'extractor_args': {
      'youtube': {
        'player_client': ['tv', 'ios', 'android'],
      },
    },
  }
  opts = apply_ytdlp_cookiefile(opts)

  with YoutubeDL(opts) as ydl:
    info = ydl.extract_info(url, download=False)

  if isinstance(info, dict) and isinstance(info.get('entries'), list):
    entries = [row for row in info.get('entries') if isinstance(row, dict)]
    if entries:
      return entries[0]

  if not isinstance(info, dict):
    raise RuntimeError('Smoke probe could not extract media metadata')
  return info


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
  opts = apply_ytdlp_cookiefile(opts)

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
  opts = apply_ytdlp_cookiefile(opts)

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
  opts = apply_ytdlp_cookiefile(opts)
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


def resolve_apple_podcast(url: str) -> PlaylistResolveResponse:
  podcast_id = extract_apple_podcast_id(url)
  if not podcast_id:
    raise RuntimeError('Invalid Apple Podcasts URL')

  payload = fetch_json(
    f'https://itunes.apple.com/lookup?id={podcast_id}&entity=podcastEpisode&limit=200',
    timeout_seconds=25,
  )
  results = payload.get('results') if isinstance(payload, dict) else []
  if not isinstance(results, list):
    results = []

  title = 'Apple Podcast'
  tracks: list[PlaylistTrack] = []
  for row in results:
    if not isinstance(row, dict):
      continue
    if str(row.get('wrapperType') or '').lower() == 'track' and str(row.get('kind') or '').lower() == 'podcast':
      title = str(row.get('collectionName') or title).strip() or title
      continue

    episode_url = str(row.get('episodeUrl') or row.get('trackViewUrl') or '').strip()
    if not episode_url:
      continue
    tracks.append(
      PlaylistTrack(
        title=str(row.get('trackName') or row.get('collectionName') or 'Podcast Episode').strip(),
        artist=str(row.get('artistName') or row.get('collectionName') or title).strip(),
        source='podcast',
        url=episode_url,
      ),
    )

  return PlaylistResolveResponse(title=title, source='podcast', total=len(tracks), tracks=tracks)


def resolve_spotify_show(url: str) -> PlaylistResolveResponse:
  show_id = extract_spotify_show_id(url)
  if not show_id:
    raise RuntimeError('Invalid Spotify show URL')

  access_token = get_spotify_access_token()
  headers = {'Authorization': f'Bearer {access_token}'}

  show_payload = fetch_json(f'https://api.spotify.com/v1/shows/{show_id}?market=US', timeout_seconds=20, headers=headers)
  show_title = str(show_payload.get('name') or 'Spotify Podcast').strip() if isinstance(show_payload, dict) else 'Spotify Podcast'
  publisher = str(show_payload.get('publisher') or show_title).strip() if isinstance(show_payload, dict) else show_title

  tracks: list[PlaylistTrack] = []
  next_url = f'https://api.spotify.com/v1/shows/{show_id}/episodes?limit=50&offset=0&market=US'
  while next_url:
    page = fetch_json(next_url, timeout_seconds=25, headers=headers)
    if not isinstance(page, dict):
      break
    rows = page.get('items')
    if not isinstance(rows, list):
      break

    for row in rows:
      if not isinstance(row, dict):
        continue
      external_urls = row.get('external_urls')
      episode_url = ''
      if isinstance(external_urls, dict):
        episode_url = str(external_urls.get('spotify') or '').strip()
      if not episode_url:
        continue
      tracks.append(
        PlaylistTrack(
          title=str(row.get('name') or 'Podcast Episode').strip(),
          artist=publisher,
          source='podcast',
          url=episode_url,
        ),
      )

    next_value = page.get('next')
    next_url = str(next_value).strip() if isinstance(next_value, str) and next_value.strip() else ''

  return PlaylistResolveResponse(title=show_title, source='podcast', total=len(tracks), tracks=tracks)


def search_podcast_episodes(query: str, limit: int) -> list[SearchItem]:
  encoded_query = urllib.parse.quote(query.strip())
  payload = fetch_json(
    f'https://itunes.apple.com/search?term={encoded_query}&media=podcast&entity=podcastEpisode&limit={max(1, min(20, limit))}',
    timeout_seconds=20,
  )
  results = payload.get('results') if isinstance(payload, dict) else []
  if not isinstance(results, list):
    return []

  items: list[SearchItem] = []
  for row in results:
    if not isinstance(row, dict):
      continue
    episode_url = str(row.get('episodeUrl') or row.get('trackViewUrl') or '').strip()
    if not episode_url:
      continue
    year_value = parse_year(str(row.get('releaseDate') or ''))
    items.append(
      SearchItem(
        id=str(row.get('trackId') or uuid.uuid4().hex),
        title=str(row.get('trackName') or 'Podcast Episode').strip(),
        artist=str(row.get('collectionName') or row.get('artistName') or 'Podcast').strip(),
        album=str(row.get('collectionName') or '').strip() or None,
        duration=max(0, int((row.get('trackTimeMillis') or 0) / 1000)) if isinstance(row.get('trackTimeMillis'), (int, float)) else 0,
        thumbnail=str(row.get('artworkUrl600') or row.get('artworkUrl100') or '').strip() or None,
        source='podcast',
        url=episode_url,
        year=int(year_value) if year_value else None,
      ),
    )
  return items


def resolve_playlist(url: str, source: str) -> PlaylistResolveResponse:
  detected_source = detect_source(url, source)
  if not is_playlist_url(url):
    raise RuntimeError('URL is not recognized as a playlist')

  if is_rss_feed_url(url):
    return resolve_rss_feed(url)
  if 'podcasts.apple.com' in url.lower():
    return resolve_apple_podcast(url)
  if extract_spotify_show_id(url):
    return resolve_spotify_show(url)

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


@app.get('/internal/archive', response_model=ArchiveResponse, dependencies=[Depends(require_api_key)])
def internal_archive(
  query: str = '',
  limit: int = 100,
  offset: int = 0,
  refresh: bool = False,
) -> ArchiveResponse:
  safe_limit = max(1, min(300, int(limit or 100)))
  safe_offset = max(0, int(offset or 0))
  q = str(query or '').strip().lower()
  tracks = scan_archive_tracks(force=refresh)

  if q:
    tokens = [part for part in re.split(r'\s+', q) if part]

    def matches(track: ArchiveTrack) -> bool:
      haystack = ' '.join([
        track.title,
        track.artist,
        track.album or '',
        track.filename,
        track.format,
        track.bpm or '',
        track.released_year or '',
        track.quality,
      ]).lower()
      return all(token in haystack for token in tokens)

    tracks = [track for track in tracks if matches(track)]

  total = len(tracks)
  page = tracks[safe_offset:safe_offset + safe_limit]
  return ArchiveResponse(
    tracks=page,
    total=total,
    limit=safe_limit,
    offset=safe_offset,
  )


@app.get('/internal/archive/browse', response_model=ArchiveBrowseResponse, dependencies=[Depends(require_api_key)])
def internal_archive_browse(
  path: str = '',
  query: str = '',
  limit: int = 120,
  offset: int = 0,
) -> ArchiveBrowseResponse:
  safe_limit = max(1, min(300, int(limit or 120)))
  safe_offset = max(0, int(offset or 0))
  safe_path = archive_relative_string(safe_archive_relative(path))
  page, total = browse_archive_items(safe_path, query, safe_limit, safe_offset)
  return ArchiveBrowseResponse(
    items=page,
    total=total,
    limit=safe_limit,
    offset=safe_offset,
    path=safe_path,
    parent_path=archive_parent_path(safe_path),
  )


@app.get('/internal/archive/files/{file_id}', dependencies=[Depends(require_api_key)])
def internal_archive_file(file_id: str) -> FileResponse:
  target = find_archive_path(file_id)
  if not target or not target.exists() or not target.is_file():
    raise HTTPException(status_code=404, detail='Archive file not found')

  return FileResponse(
    path=target,
    media_type=mimetypes.guess_type(target.name)[0] or 'application/octet-stream',
    filename=target.name,
  )


@app.post('/internal/preview', response_model=PreviewResponse, dependencies=[Depends(require_api_key)])
def internal_preview(payload: PreviewRequest) -> PreviewResponse:
  try:
    return extract_preview_info(payload.query, payload.source)
  except Exception as error:
    raise HTTPException(status_code=502, detail=f'Preview failed: {error}') from error


@app.post('/internal/metadata/lookup', response_model=MetadataLookupResponse, dependencies=[Depends(require_api_key)])
def internal_metadata_lookup(payload: MetadataLookupRequest) -> MetadataLookupResponse:
  try:
    return lookup_musicbrainz_metadata(payload.query, payload.limit)
  except Exception as error:
    raise HTTPException(status_code=502, detail=f'Metadata lookup failed: {error}') from error


@app.post('/internal/artist/discography', response_model=PlaylistResolveResponse, dependencies=[Depends(require_api_key)])
def internal_artist_discography(payload: ArtistDiscographyRequest) -> PlaylistResolveResponse:
  try:
    return lookup_artist_discography(payload.artist, payload.limit)
  except Exception as error:
    raise HTTPException(status_code=502, detail=f'Artist discography failed: {error}') from error


@app.post('/internal/search', response_model=SearchResponse, dependencies=[Depends(require_api_key)])
def internal_search(payload: SearchRequest) -> SearchResponse:
  source = (payload.source or 'all').strip().lower()

  if source == 'podcast':
    return SearchResponse(results=search_podcast_episodes(payload.query.strip(), payload.limit))

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


def workflow_status_from_state(state: dict[str, Any]) -> PlaylistWorkflowStatus:
  return PlaylistWorkflowStatus(
    workflow_id=str(state.get('workflow_id') or ''),
    status=str(state.get('status') or 'failed'),
    phase=str(state.get('phase') or 'failed'),
    control_state=str(state.get('control_state') or 'active'),
    source_url=str(state.get('source_url') or ''),
    source=str(state.get('source') or 'unknown'),
    format=str(state.get('format') or 'mp3'),
    quality=str(state.get('quality') or '320'),
    total_tracks=int(state.get('total_tracks') or 0),
    queued_count=int(state.get('queued_count') or 0),
    processing_count=int(state.get('processing_count') or 0),
    done_count=int(state.get('done_count') or 0),
    failed_count=int(state.get('failed_count') or 0),
    deduped_count=int(state.get('deduped_count') or 0),
    current_batch=int(state.get('current_batch') or 0),
    total_batches=int(state.get('total_batches') or 0),
    batch_size=int(state.get('batch_size') or PLAYLIST_WORKFLOW_BATCH_SIZE),
    archive_status=str(state.get('archive_status')) if state.get('archive_status') else None,
    archive_url=str(state.get('archive_url')) if state.get('archive_url') else None,
    error=str(state.get('error')) if state.get('error') else None,
    archive_error=str(state.get('archive_error')) if state.get('archive_error') else None,
    temporal=state.get('temporal') if isinstance(state.get('temporal'), dict) else None,
    created_at=str(state.get('created_at') or utc_now_iso()),
    updated_at=str(state.get('updated_at') or utc_now_iso()),
    finished_at=str(state.get('finished_at')) if state.get('finished_at') else None,
  )


@app.post(
  '/internal/playlist/workflow/start',
  response_model=PlaylistWorkflowStatus,
  dependencies=[Depends(require_api_key)],
)
def internal_playlist_workflow_start(
  payload: PlaylistWorkflowStartRequest,
  background_tasks: BackgroundTasks,
) -> PlaylistWorkflowStatus:
  if not is_url(payload.url):
    raise HTTPException(status_code=400, detail='Invalid URL')
  if not is_playlist_url(payload.url):
    raise HTTPException(status_code=400, detail='URL is not a playlist')

  audio_format = normalize_audio_format(payload.format)
  audio_quality = normalize_audio_quality(payload.quality, audio_format)
  detected_source = detect_source(payload.url, payload.source)
  fp = workflow_fingerprint(payload.url, detected_source, audio_format, audio_quality)

  with WORKFLOW_LOCK:
    cleanup_workflow_state()

    provided_workflow_id = str(payload.workflow_id or '').strip()
    if provided_workflow_id and provided_workflow_id in WORKFLOW_STATE:
      return workflow_status_from_state(dict(WORKFLOW_STATE[provided_workflow_id]))

    existing_id = WORKFLOW_FINGERPRINT_INDEX.get(fp)
    if existing_id and existing_id in WORKFLOW_STATE:
      existing = dict(WORKFLOW_STATE[existing_id])
      if existing.get('status') in {'queued', 'processing', 'done'}:
        return workflow_status_from_state(existing)

    workflow_id = provided_workflow_id or str(uuid.uuid4())
    batch_size = payload.batch_size if payload.batch_size and payload.batch_size > 0 else PLAYLIST_WORKFLOW_BATCH_SIZE
    state = initial_workflow_state(
      workflow_id=workflow_id,
      fingerprint=fp,
      payload=payload,
      detected_source=detected_source,
      audio_format=audio_format,
      audio_quality=audio_quality,
      batch_size=batch_size,
    )
    WORKFLOW_STATE[workflow_id] = dict(state)
    WORKFLOW_FINGERPRINT_INDEX[fp] = workflow_id

  background_tasks.add_task(run_playlist_workflow_local, workflow_id)
  return workflow_status_from_state(state)


@app.get(
  '/internal/playlist/workflow/{workflow_id}',
  response_model=PlaylistWorkflowStatus,
  dependencies=[Depends(require_api_key)],
)
def internal_playlist_workflow_status(workflow_id: str) -> PlaylistWorkflowStatus:
  state = get_workflow_state(workflow_id)
  if not state:
    raise HTTPException(status_code=404, detail='Workflow not found')
  return workflow_status_from_state(state)


@app.post(
  '/internal/playlist/workflow/{workflow_id}/pause',
  response_model=PlaylistWorkflowStatus,
  dependencies=[Depends(require_api_key)],
)
def internal_playlist_workflow_pause(workflow_id: str) -> PlaylistWorkflowStatus:
  state = get_workflow_state(workflow_id)
  if not state:
    raise HTTPException(status_code=404, detail='Workflow not found')
  if str(state.get('status') or '') in {'done', 'failed'}:
    return workflow_status_from_state(state)
  updated = update_workflow_state(
    workflow_id,
    control_state='paused',
    status='queued',
    phase='paused',
  )
  return workflow_status_from_state(updated or state)


@app.post(
  '/internal/playlist/workflow/{workflow_id}/resume',
  response_model=PlaylistWorkflowStatus,
  dependencies=[Depends(require_api_key)],
)
def internal_playlist_workflow_resume(
  workflow_id: str,
  background_tasks: BackgroundTasks,
) -> PlaylistWorkflowStatus:
  state = get_workflow_state(workflow_id)
  if not state:
    raise HTTPException(status_code=404, detail='Workflow not found')
  if str(state.get('status') or '') in {'done', 'failed'}:
    return workflow_status_from_state(state)

  updated = update_workflow_state(
    workflow_id,
    control_state='active',
    status='processing',
    phase='resuming',
    error=None,
    finished_at=None,
  )
  background_tasks.add_task(run_playlist_workflow_local, workflow_id)
  return workflow_status_from_state(updated or state)


@app.post(
  '/internal/playlist/workflow/{workflow_id}/cancel',
  response_model=PlaylistWorkflowStatus,
  dependencies=[Depends(require_api_key)],
)
def internal_playlist_workflow_cancel(workflow_id: str) -> PlaylistWorkflowStatus:
  state = get_workflow_state(workflow_id)
  if not state:
    raise HTTPException(status_code=404, detail='Workflow not found')

  updated = update_workflow_state(
    workflow_id,
    control_state='cancelled',
    status='failed',
    phase='cancelled',
    error='Cancelled by user',
    processing_count=0,
    finished_at=utc_now_iso(),
  )
  return workflow_status_from_state(updated or state)


def sanitize_archive_component(raw: str, fallback: str) -> str:
  value = re.sub(r'[^a-zA-Z0-9._\-\s]+', '', (raw or '').strip())
  value = re.sub(r'\s+', ' ', value).strip(' .')
  return value[:120] or fallback


@app.post(
  '/internal/playlist/zip',
  response_model=PlaylistZipResponse,
  dependencies=[Depends(require_api_key)],
)
def internal_playlist_zip(payload: PlaylistZipRequest) -> PlaylistZipResponse:
  if not payload.files:
    raise HTTPException(status_code=400, detail='Playlist ZIP needs at least one file')
  if len(payload.files) > PLAYLIST_ZIP_MAX_FILES:
    raise HTTPException(status_code=400, detail=f'Playlist ZIP limit exceeded ({PLAYLIST_ZIP_MAX_FILES})')

  archive_file_name = f'playlist-{sanitize_archive_component(payload.workflow_id, "workflow")}-{uuid.uuid4().hex[:8]}.zip'
  archive_path = STORAGE_DIR / archive_file_name

  file_count = 0
  try:
    with zipfile.ZipFile(archive_path, mode='w', compression=zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
      digits = max(2, len(str(len(payload.files))))
      for index, item in enumerate(payload.files, start=1):
        ext = sanitize_archive_component(item.format.lower(), 'mp3') or 'mp3'
        artist = sanitize_archive_component(item.artist, 'Unknown Artist')
        title = sanitize_archive_component(item.title, f'Track {index}')
        member_name = f'{index:0{digits}d} - {artist} - {title}.{ext}'

        request = urllib.request.Request(
          item.download_url,
          headers={
            'User-Agent': 'SoundDropDownloader/8.0',
            'Accept': '*/*',
          },
        )
        with urllib.request.urlopen(request, timeout=180) as response:
          data = response.read()
          if not data:
            continue
          zf.writestr(member_name, data)
          file_count += 1
  except urllib.error.URLError as error:
    archive_path.unlink(missing_ok=True)
    raise HTTPException(status_code=502, detail=f'ZIP fetch failed: {error}') from error
  except Exception as error:
    archive_path.unlink(missing_ok=True)
    raise HTTPException(status_code=502, detail=f'ZIP build failed: {error}') from error

  if file_count == 0:
    archive_path.unlink(missing_ok=True)
    raise HTTPException(status_code=400, detail='No downloadable files were available for ZIP')

  stat = archive_path.stat()
  return PlaylistZipResponse(
    download_url=f'{PUBLIC_BASE_URL}/internal/files/{archive_file_name}',
    filename=archive_file_name,
    file_size=stat.st_size,
    file_count=file_count,
  )


@app.post('/internal/download', response_model=DownloadResponse, dependencies=[Depends(require_api_key)])
def internal_download(payload: DownloadRequest) -> DownloadResponse:
  audio_format = normalize_audio_format(payload.format)
  audio_quality = normalize_audio_quality(payload.quality, audio_format)

  if audio_format not in SUPPORTED_FORMATS:
    raise HTTPException(status_code=400, detail='Unsupported format')
  if audio_quality not in SUPPORTED_QUALITIES:
    raise HTTPException(status_code=400, detail='Unsupported quality')
  if not is_download_target(payload.url):
    raise HTTPException(status_code=400, detail='Invalid download target')

  attempt_errors: list[str] = []
  selected_output: Path | None = None
  selected_info: dict[str, Any] | None = None
  selected_url = payload.url
  selected_source = detect_source(payload.url, payload.source)
  fallback_used = False

  for source_candidate in source_fallback_chain(payload.url, payload.source):
    for quality_candidate in quality_fallback_chain(audio_format, audio_quality):
      ffmpeg_quality = choose_quality(audio_format, quality_candidate)
      resolved_url = payload.url
      resolved_source = source_candidate
      attempt_fallback_used = False

      if source_candidate in FALLBACK_SOURCES or (
        source_candidate == 'youtube' and detect_source(payload.url, payload.source) in FALLBACK_SOURCES
      ):
        try:
          title, artist = extract_track_metadata(payload.url)
          resolved_url = find_youtube_mirror_url(title, artist)
          resolved_source = 'youtube'
          attempt_fallback_used = True
        except Exception as fallback_error:
          if source_candidate in FALLBACK_SOURCES:
            attempt_errors.append(
              f'{source_candidate}/{quality_candidate}: mirror-fallback failed: {fallback_error}',
            )
            continue

      try:
        output, info = run_download(payload.job_id, resolved_url, audio_format, ffmpeg_quality)
        selected_output = output
        selected_info = info
        selected_url = resolved_url
        selected_source = resolved_source
        fallback_used = attempt_fallback_used
        break
      except Exception as download_error:
        attempt_errors.append(
          f'{resolved_source}/{quality_candidate}: {download_error}',
        )
        continue
    if selected_output and selected_info:
      break

  if not selected_output or not selected_info:
    detail = ' | '.join(attempt_errors[-8:]) if attempt_errors else 'No successful download variant'
    raise HTTPException(status_code=502, detail=f'Download failed: {detail}')

  file_id = f"{payload.job_id}-{uuid.uuid4().hex}.{audio_format}"
  target = STORAGE_DIR / file_id
  target.parent.mkdir(parents=True, exist_ok=True)

  shutil.move(str(selected_output), target)
  shutil.rmtree(selected_output.parent, ignore_errors=True)

  stat = target.stat()
  mime_type = mimetypes.guess_type(target.name)[0] or 'application/octet-stream'

  title = str(selected_info.get('track') or selected_info.get('title') or 'Unknown Title')
  artist = str(selected_info.get('artist') or selected_info.get('uploader') or selected_info.get('channel') or 'Unknown Artist')
  duration_value = selected_info.get('duration')
  duration = int(duration_value) if isinstance(duration_value, (int, float)) else 0
  display_filename = target.name
  if payload.local_relpath:
    requested_name = Path(str(payload.local_relpath).replace('\\', '/')).name
    requested_stem = Path(requested_name).stem
    if requested_stem:
      display_filename = f'{sanitize_archive_component(requested_stem, payload.job_id)}.{audio_format}'

  return DownloadResponse(
    download_url=f'{PUBLIC_BASE_URL}/internal/files/{file_id}',
    title=title,
    artist=artist,
    duration=duration,
    file_size=stat.st_size,
    source=selected_source,
    resolved_url=selected_url,
    fallback_used=fallback_used,
    mime_type=mime_type,
    filename=display_filename,
  )


@app.post('/internal/smoke', response_model=SmokeResponse, dependencies=[Depends(require_api_key)])
def internal_smoke(payload: SmokeRequest) -> SmokeResponse:
  audio_format = normalize_audio_format(payload.format)
  audio_quality = normalize_audio_quality(payload.quality, audio_format)

  if audio_format not in SUPPORTED_FORMATS:
    raise HTTPException(status_code=400, detail='Unsupported format')
  if audio_quality not in SUPPORTED_QUALITIES:
    raise HTTPException(status_code=400, detail='Unsupported quality')
  if not is_url(payload.url):
    raise HTTPException(status_code=400, detail='Invalid URL')

  attempt_errors: list[str] = []
  initial_source = detect_source(payload.url, payload.source)

  for source_candidate in source_fallback_chain(payload.url, payload.source):
    for quality_candidate in quality_fallback_chain(audio_format, audio_quality):
      resolved_url = payload.url
      resolved_source = source_candidate
      fallback_used = False

      if source_candidate in FALLBACK_SOURCES or (
        source_candidate == 'youtube' and initial_source in FALLBACK_SOURCES
      ):
        try:
          title, artist = extract_track_metadata(payload.url)
          resolved_url = find_youtube_mirror_url(title, artist)
          resolved_source = 'youtube'
          fallback_used = True
        except Exception as fallback_error:
          if source_candidate in FALLBACK_SOURCES:
            attempt_errors.append(
              f'{source_candidate}/{quality_candidate}: mirror-fallback failed: {fallback_error}',
            )
            continue

      try:
        info = probe_download_metadata(resolved_url)
        title = str(info.get('track') or info.get('title') or 'Unknown Title')
        artist = str(info.get('artist') or info.get('uploader') or info.get('channel') or 'Unknown Artist')
        duration_value = info.get('duration')
        duration = int(duration_value) if isinstance(duration_value, (int, float)) else 0
        return SmokeResponse(
          ok=True,
          source=resolved_source,
          resolved_url=resolved_url,
          fallback_used=fallback_used,
          title=title,
          artist=artist,
          duration=duration,
        )
      except Exception as probe_error:
        attempt_errors.append(f'{resolved_source}/{quality_candidate}: {probe_error}')
        continue

  detail = ' | '.join(attempt_errors[-8:]) if attempt_errors else 'No successful smoke variant'
  raise HTTPException(status_code=502, detail=f'Smoke probe failed: {detail}')


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
