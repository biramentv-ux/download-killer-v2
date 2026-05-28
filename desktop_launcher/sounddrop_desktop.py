from __future__ import annotations

import base64
import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_PRIMARY_URL = 'https://sounddrop.biramentv.workers.dev'
DEFAULT_FALLBACK_URLS = [
    'https://download-killer-v2.net',
    'https://www.download-killer-v2.net',
]
ENV_URL = 'SOUNDDROP_URL'
ENV_SYNC_KEY = 'SOUNDDROP_SYNC_KEY'
SYNC_KEY_FILENAME = 'sounddrop_sync_key.txt'
HEALTH_PATH = '/api/health'
REQUEST_TIMEOUT_SECONDS = 4
LOG_FILE = Path(tempfile.gettempdir()) / 'sounddrop_desktop.log'

SUPPORTED_FORMATS = {'mp3', 'flac', 'ogg', 'm4a', 'opus', 'wav'}
SUPPORTED_QUALITIES = {'320', '256', '192', '128', '96', 'best', 'lossless'}
FALLBACK_SOURCES = {'spotify', 'deezer', 'apple'}
IS_WINDOWS = sys.platform.startswith('win')
IS_MACOS = sys.platform == 'darwin'
APP_VERSION = '7.2.0'
APP_PLATFORM = 'windows' if IS_WINDOWS else ('macos' if IS_MACOS else 'desktop')
APP_USER_AGENT = f'SoundDropDesktop/{APP_VERSION} ({APP_PLATFORM})'
APP_HTTP_USER_AGENT = f'Mozilla/5.0 (compatible; {APP_USER_AGENT})'
YTDLP_BIN_URL_WINDOWS = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
YTDLP_BIN_URL_MACOS = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'
FFMPEG_ARCHIVE_URL_WINDOWS = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
FFMPEG_ARCHIVE_URL_MACOS = 'https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip'
SPOTIFY_CLIENT_ID = os.getenv('SPOTIFY_CLIENT_ID', '').strip()
SPOTIFY_CLIENT_SECRET = os.getenv('SPOTIFY_CLIENT_SECRET', '').strip()


def log(message: str) -> None:
    stamp = datetime.now(timezone.utc).isoformat(timespec='seconds')
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        with LOG_FILE.open('a', encoding='utf-8') as handle:
            handle.write(f'[{stamp}] {message}\n')
    except Exception:
        pass


def app_dir() -> Path:
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def normalize_url(raw: str) -> str:
    value = raw.strip()
    if not value:
        return ''
    value = value.rstrip('/')
    if not value.startswith(('http://', 'https://')):
        return f'https://{value}'
    return value


def is_url(value: str) -> bool:
    try:
        parsed = urllib.parse.urlparse(value)
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
    return (fallback or 'unknown').strip().lower()


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


def extract_spotify_playlist_id(raw_url: str) -> str | None:
    match = re.search(r'spotify\.com/playlist/([a-zA-Z0-9]+)', raw_url)
    return match.group(1) if match else None


def extract_deezer_playlist_id(raw_url: str) -> str | None:
    match = re.search(r'deezer\.com/(?:[a-z]{2}/)?playlist/([0-9]+)', raw_url)
    return match.group(1) if match else None


def fetch_json(url: str, timeout_seconds: int = 20, headers: dict[str, str] | None = None) -> Any:
    request_headers = {
        'User-Agent': APP_HTTP_USER_AGENT,
        'Accept': 'application/json,text/plain,*/*',
    }
    if headers:
        request_headers.update(headers)

    request = urllib.request.Request(url, headers=request_headers)
    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        raw = response.read().decode('utf-8', errors='replace')
    return json.loads(raw)


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
            'Spotify access token unavailable. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET for playlist support.',
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
            'User-Agent': APP_USER_AGENT,
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


def choose_quality(requested_format: str, requested_quality: str) -> str:
    if requested_quality == 'lossless' or requested_format in {'flac', 'wav'}:
        return '0'
    if requested_quality == 'best':
        return '0'
    return requested_quality


def sanitize_file_component(value: str, fallback: str) -> str:
    raw = (value or '').strip()
    if not raw:
        raw = fallback
    clean = re.sub(r'[^a-zA-Z0-9\-\._\s]+', '', raw)
    clean = re.sub(r'\s+', ' ', clean).strip(' .')
    return clean or fallback


def extract_entries(raw: dict[str, Any]) -> list[dict[str, Any]]:
    entries = raw.get('entries')
    if isinstance(entries, list):
        return [entry for entry in entries if isinstance(entry, dict)]
    return [raw]


def normalize_result_url(item: dict[str, Any]) -> str:
    url = str(item.get('webpage_url') or item.get('url') or '').strip()
    if url and url.startswith('http'):
        return url

    extractor_key = str(item.get('extractor_key') or '').lower()
    video_id = str(item.get('id') or '').strip()
    if video_id and extractor_key.startswith('youtube'):
        return f'https://www.youtube.com/watch?v={video_id}'

    return ''


def pick_output_file(work_dir: Path, info: dict[str, Any]) -> Path:
  prefix = str(info.get('id') or '')
  candidates = [file for file in work_dir.glob(f'{prefix}.*') if file.is_file()] if prefix else []
  if not candidates:
    candidates = [file for file in work_dir.glob('*') if file.is_file()]
  if not candidates:
    raise RuntimeError('No file produced by yt-dlp')
  return max(candidates, key=lambda file: file.stat().st_mtime)


def local_tool_dir() -> Path:
  if IS_WINDOWS:
    base = Path(os.getenv('LOCALAPPDATA') or tempfile.gettempdir())
  else:
    base = Path(os.getenv('XDG_DATA_HOME') or (Path.home() / '.local' / 'share'))
  path = base / 'SoundDropDesktop' / 'tools'
  path.mkdir(parents=True, exist_ok=True)
  return path


def download_binary(url: str, destination: Path) -> None:
  destination.parent.mkdir(parents=True, exist_ok=True)
  request = urllib.request.Request(
    url,
    headers={
      'User-Agent': APP_USER_AGENT,
      'Accept': '*/*',
    },
  )
  with urllib.request.urlopen(request, timeout=180) as response, destination.open('wb') as handle:
    shutil.copyfileobj(response, handle, length=1024 * 256)


def make_executable(path: Path) -> None:
  if IS_WINDOWS:
    return
  current = path.stat().st_mode
  path.chmod(current | 0o111)


def ensure_ytdlp_binary() -> Path:
  existing = shutil.which('yt-dlp')
  if existing:
    return Path(existing)

  filename = 'yt-dlp.exe' if IS_WINDOWS else 'yt-dlp'
  target = local_tool_dir() / filename
  if target.exists() and target.is_file():
    make_executable(target)
    return target

  if IS_WINDOWS:
    source_url = YTDLP_BIN_URL_WINDOWS
  elif IS_MACOS:
    source_url = YTDLP_BIN_URL_MACOS
  else:
    raise RuntimeError('Unsupported OS for bundled yt-dlp. Install yt-dlp manually and retry.')

  log(f'Downloading {filename}...')
  download_binary(source_url, target)
  if not target.exists():
    raise RuntimeError('Failed to download yt-dlp binary')
  make_executable(target)
  return target


def ensure_ffmpeg_binary() -> Path:
  existing = shutil.which('ffmpeg')
  if existing:
    return Path(existing)

  tool_dir = local_tool_dir()
  ffmpeg_name = 'ffmpeg.exe' if IS_WINDOWS else 'ffmpeg'
  ffmpeg_bin = tool_dir / ffmpeg_name
  if ffmpeg_bin.exists() and ffmpeg_bin.is_file():
    make_executable(ffmpeg_bin)
    return ffmpeg_bin

  if IS_WINDOWS:
    archive = tool_dir / 'ffmpeg-release-essentials.zip'
    log('Downloading ffmpeg essentials archive...')
    download_binary(FFMPEG_ARCHIVE_URL_WINDOWS, archive)

    extracted = False
    with zipfile.ZipFile(archive, 'r') as zip_handle:
      for member in zip_handle.namelist():
        normalized = member.replace('\\', '/').lower()
        if normalized.endswith('/bin/ffmpeg.exe'):
          with zip_handle.open(member, 'r') as source, ffmpeg_bin.open('wb') as target:
            shutil.copyfileobj(source, target)
          extracted = True
          break

    if not extracted:
      raise RuntimeError('Unable to locate ffmpeg.exe inside downloaded archive')
  elif IS_MACOS:
    archive = tool_dir / 'ffmpeg-macos.zip'
    log('Downloading ffmpeg archive for macOS...')
    download_binary(FFMPEG_ARCHIVE_URL_MACOS, archive)

    extracted = False
    with zipfile.ZipFile(archive, 'r') as zip_handle:
      for member in zip_handle.namelist():
        normalized = member.replace('\\', '/').strip('/')
        if normalized.lower().endswith('/ffmpeg') or normalized.lower() == 'ffmpeg':
          with zip_handle.open(member, 'r') as source, ffmpeg_bin.open('wb') as target:
            shutil.copyfileobj(source, target)
          extracted = True
          break

    if not extracted:
      raise RuntimeError('Unable to locate ffmpeg binary inside downloaded archive')
  else:
    raise RuntimeError('Unsupported OS for bundled ffmpeg. Install ffmpeg manually and retry.')

  try:
    archive.unlink(missing_ok=True)
  except Exception:
    pass

  if not ffmpeg_bin.exists():
    raise RuntimeError('Failed to prepare ffmpeg binary')
  make_executable(ffmpeg_bin)
  return ffmpeg_bin


def run_command(command: list[str], timeout_seconds: int = 300) -> str:
  result = subprocess.run(
    command,
    capture_output=True,
    text=True,
    encoding='utf-8',
    errors='replace',
    timeout=timeout_seconds,
    check=False,
  )
  if result.returncode != 0:
    stderr = (result.stderr or '').strip()
    stdout = (result.stdout or '').strip()
    details = stderr or stdout or f'Exit code {result.returncode}'
    raise RuntimeError(details[-2000:])
  return result.stdout or ''


def fetch_text(url: str, timeout_seconds: int = 20) -> str:
  request = urllib.request.Request(
    url,
    headers={
      'User-Agent': APP_HTTP_USER_AGENT,
      'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
    },
  )
  with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
    return response.read().decode('utf-8', errors='replace')


def extract_og_values(html: str) -> tuple[str, str]:
  title_match = re.search(r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
  desc_match = re.search(r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
  title = title_match.group(1).strip() if title_match else ''
  description = desc_match.group(1).strip() if desc_match else ''
  return title, description


def extract_artist_from_description(description: str) -> str:
  if not description:
    return ''
  # Spotify/Apple pages often use bullet separators: "Artist · Album · Song · 2026"
  parts = [segment.strip() for segment in description.split('·') if segment.strip()]
  return parts[0] if parts else ''


def extract_spotify_metadata(url: str) -> tuple[str, str] | None:
  try:
    oembed_url = f'https://open.spotify.com/oembed?url={urllib.parse.quote(url, safe="")}'
    raw = fetch_text(oembed_url, timeout_seconds=20)
    payload = json.loads(raw)
    title = str(payload.get('title') or '').strip() if isinstance(payload, dict) else ''

    page_html = fetch_text(url, timeout_seconds=20)
    _, description = extract_og_values(page_html)
    artist = extract_artist_from_description(description)

    if not title and not artist:
      return None
    return title or 'Unknown Title', artist or 'Unknown Artist'
  except Exception as error:
    log(f'Spotify metadata extraction failed: {error}')
    return None


def extract_og_metadata(url: str) -> tuple[str, str] | None:
  try:
    html = fetch_text(url, timeout_seconds=20)
    title, description = extract_og_values(html)
    artist = extract_artist_from_description(description)
    if not title and not artist:
      return None
    return title or 'Unknown Title', artist or 'Unknown Artist'
  except Exception as error:
    log(f'OG metadata extraction failed for {url}: {error}')
    return None


def load_sidecar_urls() -> list[str]:
    base = app_dir()
    urls: list[str] = []

    txt_path = base / 'sounddrop_desktop.url'
    if txt_path.exists():
        try:
            raw = txt_path.read_text(encoding='utf-8').strip()
            normalized = normalize_url(raw)
            if normalized:
                urls.append(normalized)
        except Exception as error:
            log(f'Failed to read sidecar url file: {error}')

    json_path = base / 'sounddrop_desktop.json'
    if json_path.exists():
        try:
            data: Any = json.loads(json_path.read_text(encoding='utf-8'))
            if isinstance(data, dict):
                first = data.get('url')
                if isinstance(first, str):
                    normalized = normalize_url(first)
                    if normalized:
                        urls.append(normalized)
                fallback = data.get('fallback_urls')
                if isinstance(fallback, list):
                    for item in fallback:
                        if isinstance(item, str):
                            normalized = normalize_url(item)
                            if normalized:
                                urls.append(normalized)
        except Exception as error:
            log(f'Failed to read sidecar json file: {error}')

    return urls


def dedupe(values: list[str]) -> list[str]:
    result: list[str] = []
    seen = set()
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def candidate_urls() -> list[str]:
    env_raw = os.getenv(ENV_URL, '')
    env_url = normalize_url(env_raw) if env_raw else ''
    sidecar = load_sidecar_urls()

    candidates = dedupe(
        [env_url] + sidecar + [DEFAULT_PRIMARY_URL] + DEFAULT_FALLBACK_URLS
    )
    return [url for url in candidates if url]


def is_valid_sync_key(value: str) -> bool:
    return bool(re.fullmatch(r'[A-Za-z0-9_-]{8,64}', value))


def read_persisted_sync_key() -> str:
    sync_path = app_dir() / SYNC_KEY_FILENAME
    if not sync_path.exists():
        return ''
    try:
        key = sync_path.read_text(encoding='utf-8').strip()
    except Exception as error:
        log(f'Failed to read sync key file: {error}')
        return ''
    return key if is_valid_sync_key(key) else ''


def persist_sync_key(key: str) -> None:
    if not is_valid_sync_key(key):
        return
    sync_path = app_dir() / SYNC_KEY_FILENAME
    try:
        sync_path.write_text(key, encoding='utf-8')
    except Exception as error:
        log(f'Failed to persist sync key file: {error}')


def resolve_sync_key() -> str:
    from_env = os.getenv(ENV_SYNC_KEY, '').strip()
    if is_valid_sync_key(from_env):
        persist_sync_key(from_env)
        return from_env

    from_file = read_persisted_sync_key()
    if from_file:
        return from_file

    generated = f'sd{uuid.uuid4().hex[:20]}'
    persist_sync_key(generated)
    return generated


def attach_sync_key(base_url: str, sync_key: str) -> str:
    parsed = urllib.parse.urlsplit(base_url)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    if sync_key:
        query['sync'] = [sync_key]
    encoded = urllib.parse.urlencode(query, doseq=True)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, encoded, parsed.fragment))

def detect_preferred_language() -> str:
    env_lang = os.getenv('SOUNDDROP_LANG', '').strip().lower()
    if env_lang in {'bg', 'en'}:
        return env_lang

    locale_candidates = [
        os.getenv('LANG', ''),
        os.getenv('LC_ALL', ''),
        os.getenv('LC_MESSAGES', ''),
    ]
    for candidate in locale_candidates:
        normalized = str(candidate or '').lower()
        if normalized.startswith('bg'):
            return 'bg'
        if normalized.startswith('en'):
            return 'en'

    try:
        import locale
        locale_value = locale.getdefaultlocale()[0] or ''
        normalized = locale_value.lower()
        if normalized.startswith('bg'):
            return 'bg'
    except Exception:
        pass

    return 'en'

def attach_launcher_params(base_url: str, language: str) -> str:
    parsed = urllib.parse.urlsplit(base_url)
    query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
    query['client'] = ['desktop']
    query['platform'] = [APP_PLATFORM]
    query['launcher'] = [APP_VERSION]
    if language in {'bg', 'en'} and 'lang' not in query:
        query['lang'] = [language]
    encoded = urllib.parse.urlencode(query, doseq=True)
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, encoded, parsed.fragment))


def health_ok(base_url: str) -> bool:
    health_url = f'{base_url}{HEALTH_PATH}'
    request = urllib.request.Request(
        health_url,
        headers={
            'User-Agent': APP_USER_AGENT,
            'Accept': 'application/json',
        },
    )

    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
            if response.status != 200:
                return False
            payload = json.loads(response.read().decode('utf-8', errors='replace'))
            if isinstance(payload, dict):
                data = payload.get('data')
                if isinstance(data, dict) and data.get('ok') is True:
                    return True
                if payload.get('ok') is True:
                    return True
            return True
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, ValueError) as error:
        log(f'Health check failed for {base_url}: {error}')
        return False


def resolve_target_url() -> str:
    urls = candidate_urls()
    for url in urls:
        if health_ok(url):
            log(f'Selected healthy endpoint: {url}')
            return url

    if urls:
        log(f'No healthy endpoint found, using first candidate: {urls[0]}')
        return urls[0]

    log(f'No candidates detected, fallback to default: {DEFAULT_PRIMARY_URL}')
    return DEFAULT_PRIMARY_URL


class DesktopBridge:
    def __init__(self) -> None:
        self.window = None

    def attach_window(self, window: Any) -> None:
        self.window = window

    def ping(self) -> dict[str, Any]:
        return {'ok': True, 'bridge': 'sounddrop-desktop'}

    def save_remote_file(self, download_url: str, suggested_filename: str = 'download.bin') -> dict[str, Any]:
        if not is_url(download_url):
            return {'ok': False, 'error': 'Invalid download URL'}

        target_path = self._pick_save_target(suggested_filename)
        if target_path is None:
            return {'ok': False, 'cancelled': True}

        request = urllib.request.Request(
            download_url,
            headers={
                'User-Agent': APP_USER_AGENT,
                'Accept': '*/*',
            },
        )

        try:
            with urllib.request.urlopen(request, timeout=60) as response, target_path.open('wb') as handle:
                shutil.copyfileobj(response, handle, length=1024 * 256)
            return {
                'ok': True,
                'path': str(target_path),
                'bytes': target_path.stat().st_size,
            }
        except Exception as error:
            log(f'save_remote_file failed: {error}')
            return {'ok': False, 'error': str(error)}

    def download_track(
        self,
        url: str,
        audio_format: str = 'mp3',
        audio_quality: str = '320',
        source: str = 'unknown',
        title: str = 'Unknown Title',
        artist: str = 'Unknown Artist',
    ) -> dict[str, Any]:
        if not is_url(url):
            return {'ok': False, 'error': 'Invalid URL'}
        if is_playlist_url(url):
            return self.download_playlist(url, audio_format, audio_quality, source)

        requested_format = (audio_format or 'mp3').strip().lower()
        requested_quality = (audio_quality or '320').strip().lower()
        if requested_format not in SUPPORTED_FORMATS:
            return {'ok': False, 'error': 'Unsupported format'}
        if requested_quality not in SUPPORTED_QUALITIES:
            return {'ok': False, 'error': 'Unsupported quality'}

        safe_artist = sanitize_file_component(artist, 'Unknown Artist')
        safe_title = sanitize_file_component(title, 'Track')
        if is_url(title) or title.lower().startswith('direct url'):
            safe_title = 'Track'
        suggested_name = f'{safe_artist} - {safe_title}.{requested_format}'

        target_path = self._pick_save_target(suggested_name)
        if target_path is None:
            return {'ok': False, 'cancelled': True}

        ffmpeg_quality = choose_quality(requested_format, requested_quality)
        detected_source = detect_source(url, source)
        resolved_source = detected_source
        resolved_url = url
        fallback_used = False

        try:
            if detected_source in FALLBACK_SOURCES:
                meta_title, meta_artist = self._extract_track_metadata(url)
                resolved_url = self._find_youtube_mirror_url(meta_title, meta_artist)
                resolved_source = 'youtube'
                fallback_used = True

            output_path, info = self._run_download(resolved_url, requested_format, ffmpeg_quality)
        except Exception as primary_error:
            if not fallback_used and detected_source in FALLBACK_SOURCES:
                try:
                    meta_title, meta_artist = self._extract_track_metadata(url)
                    resolved_url = self._find_youtube_mirror_url(meta_title, meta_artist)
                    resolved_source = 'youtube'
                    fallback_used = True
                    output_path, info = self._run_download(resolved_url, requested_format, ffmpeg_quality)
                except Exception as secondary_error:
                    return {
                        'ok': False,
                        'error': f'Download failed. primary={primary_error}; fallback={secondary_error}',
                    }
            else:
                return {'ok': False, 'error': f'Download failed: {primary_error}'}

        try:
            target_path.parent.mkdir(parents=True, exist_ok=True)
            if target_path.exists():
                target_path.unlink()
            shutil.move(str(output_path), str(target_path))
            shutil.rmtree(output_path.parent, ignore_errors=True)
        except Exception as error:
            return {'ok': False, 'error': f'Failed to move output file: {error}'}

        file_size = target_path.stat().st_size
        result_title = str(info.get('track') or info.get('title') or safe_title)
        result_artist = str(info.get('artist') or info.get('uploader') or info.get('channel') or safe_artist)
        duration_value = info.get('duration')
        duration = int(duration_value) if isinstance(duration_value, (int, float)) else 0

        return {
            'ok': True,
            'path': str(target_path),
            'bytes': file_size,
            'title': result_title,
            'artist': result_artist,
            'duration': duration,
            'source': resolved_source,
            'resolved_url': resolved_url,
            'fallback_used': fallback_used,
            'mime_type': mimetypes.guess_type(target_path.name)[0] or 'application/octet-stream',
        }

    def download_playlist(
        self,
        url: str,
        audio_format: str = 'mp3',
        audio_quality: str = '320',
        source: str = 'unknown',
    ) -> dict[str, Any]:
        if not is_url(url):
            return {'ok': False, 'error': 'Invalid URL'}
        if not is_playlist_url(url):
            return {'ok': False, 'error': 'URL is not recognized as a playlist'}

        requested_format = (audio_format or 'mp3').strip().lower()
        requested_quality = (audio_quality or '320').strip().lower()
        if requested_format not in SUPPORTED_FORMATS:
            return {'ok': False, 'error': 'Unsupported format'}
        if requested_quality not in SUPPORTED_QUALITIES:
            return {'ok': False, 'error': 'Unsupported quality'}

        try:
            playlist = self._extract_playlist_tracks(url, source)
        except Exception as error:
            log(f'playlist resolve failed: {error}')
            return {'ok': False, 'error': f'Playlist resolve failed: {error}'}

        tracks = playlist.get('tracks') or []
        if not tracks:
            return {'ok': False, 'error': 'No tracks found in playlist'}

        folder = self._pick_save_folder(playlist.get('title') or 'Playlist')
        if folder is None:
            return {'ok': False, 'cancelled': True}

        requested_ffmpeg_quality = choose_quality(requested_format, requested_quality)
        saved: list[dict[str, Any]] = []
        failed: list[dict[str, Any]] = []

        for index, track in enumerate(tracks, start=1):
            track_url = str(track.get('url') or '').strip()
            track_title = str(track.get('title') or f'Track {index}')
            track_artist = str(track.get('artist') or 'Unknown Artist')
            track_source = str(track.get('source') or detect_source(track_url, source))

            try:
                resolved_url, resolved_source, fallback_used = self._resolve_track_download_target(
                    track_url,
                    track_source,
                    track_title,
                    track_artist,
                )

                output_path, info = self._run_download(resolved_url, requested_format, requested_ffmpeg_quality)
                final_artist = sanitize_file_component(
                    str(info.get('artist') or info.get('uploader') or info.get('channel') or track_artist),
                    'Unknown Artist',
                )
                final_title = sanitize_file_component(
                    str(info.get('track') or info.get('title') or track_title),
                    f'Track {index}',
                )
                out_name = f'{index:04d} - {final_artist} - {final_title}.{requested_format}'
                destination = self._unique_path(folder / out_name)
                destination.parent.mkdir(parents=True, exist_ok=True)
                if destination.exists():
                    destination.unlink()
                shutil.move(str(output_path), str(destination))
                shutil.rmtree(output_path.parent, ignore_errors=True)

                saved.append(
                    {
                        'index': index,
                        'title': final_title,
                        'artist': final_artist,
                        'path': str(destination),
                        'source': resolved_source,
                        'resolved_url': resolved_url,
                        'fallback_used': fallback_used,
                        'bytes': destination.stat().st_size,
                    },
                )
            except Exception as error:
                log(f'playlist track failed #{index}: {error}')
                failed.append(
                    {
                        'index': index,
                        'title': track_title,
                        'artist': track_artist,
                        'source': track_source,
                        'error': str(error),
                    },
                )

        total = len(tracks)
        saved_count = len(saved)
        failed_count = len(failed)

        if saved_count == 0:
            first_error = failed[0]['error'] if failed else 'Unknown error'
            return {'ok': False, 'error': f'Playlist download failed: {first_error}', 'total': total, 'failed': failed_count}

        return {
            'ok': failed_count == 0,
            'partial': failed_count > 0,
            'total': total,
            'saved': saved_count,
            'failed': failed_count,
            'playlist_title': playlist.get('title') or 'Playlist',
            'folder': str(folder),
            'items': saved,
            'failed_items': failed,
        }

    def _pick_save_folder(self, playlist_title: str) -> Path | None:
        if self.window is None:
            return None

        default_dir = Path.home() / 'Downloads' / sanitize_file_component(playlist_title, 'Playlist')
        try:
            import webview  # type: ignore

            result = self.window.create_file_dialog(
                webview.FOLDER_DIALOG,
                directory=str(default_dir.parent),
            )
            if not result:
                return None

            selected = result[0] if isinstance(result, (tuple, list)) else result
            path = Path(str(selected)).resolve()
            path.mkdir(parents=True, exist_ok=True)
            return path
        except Exception as error:
            log(f'Folder dialog failed: {error}')
            return None

    def _extract_playlist_tracks(self, url: str, source: str) -> dict[str, Any]:
        detected = detect_source(url, source)

        primary_error: Exception | None = None
        try:
            return self._extract_playlist_tracks_ytdlp(url, detected)
        except Exception as error:
            primary_error = error
            log(f'yt-dlp playlist extraction failed: {error}')

        if detected == 'spotify':
            try:
                return self._extract_spotify_playlist_tracks(url)
            except Exception as error:
                log(f'Spotify playlist extraction fallback failed: {error}')
                raise RuntimeError(f'Could not resolve Spotify playlist: {error}') from error

        if detected == 'deezer':
            try:
                return self._extract_deezer_playlist_tracks(url)
            except Exception as error:
                log(f'Deezer playlist extraction fallback failed: {error}')
                raise RuntimeError(f'Could not resolve Deezer playlist: {error}') from error

        if primary_error is not None:
            raise RuntimeError(str(primary_error)) from primary_error
        raise RuntimeError('Playlist extraction failed')

    def _extract_playlist_tracks_ytdlp(self, url: str, source: str) -> dict[str, Any]:
        ytdlp_path = ensure_ytdlp_binary()
        command = [
            str(ytdlp_path),
            '--skip-download',
            '--flat-playlist',
            '--no-warnings',
            '--dump-single-json',
            url,
        ]
        raw = run_command(command, timeout_seconds=1800)
        lines = [line.strip() for line in raw.splitlines() if line.strip()]
        if not lines:
            raise RuntimeError('yt-dlp did not return playlist metadata')

        payload: dict[str, Any] | None = None
        for line in reversed(lines):
            try:
                parsed = json.loads(line)
            except Exception:
                continue
            if isinstance(parsed, dict):
                payload = parsed
                break

        if payload is None:
            raise RuntimeError('yt-dlp returned invalid playlist payload')

        title = str(payload.get('title') or payload.get('playlist_title') or 'Playlist').strip() or 'Playlist'
        entries = extract_entries(payload)
        tracks: list[dict[str, Any]] = []
        for index, entry in enumerate(entries, start=1):
            normalized = self._normalize_playlist_entry(entry, source, index)
            if normalized:
                tracks.append(normalized)

        return {
            'title': title,
            'source': source,
            'tracks': tracks,
            'total': len(tracks),
        }

    def _extract_spotify_playlist_tracks(self, url: str) -> dict[str, Any]:
        playlist_id = extract_spotify_playlist_id(url)
        if not playlist_id:
            raise RuntimeError('Invalid Spotify playlist URL')

        access_token = get_spotify_access_token()

        headers = {'Authorization': f'Bearer {access_token}'}
        meta = fetch_json(f'https://api.spotify.com/v1/playlists/{playlist_id}', timeout_seconds=20, headers=headers)
        playlist_title = str(meta.get('name') or 'Spotify Playlist').strip() if isinstance(meta, dict) else 'Spotify Playlist'

        tracks: list[dict[str, Any]] = []
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
                    for item in artists_raw:
                        if isinstance(item, dict):
                            name = str(item.get('name') or '').strip()
                            if name:
                                artists.append(name)
                artist = ', '.join(artists) if artists else 'Unknown Artist'
                ext_urls = track.get('external_urls')
                track_url = ''
                if isinstance(ext_urls, dict):
                    track_url = str(ext_urls.get('spotify') or '').strip()

                tracks.append(
                    {
                        'title': title,
                        'artist': artist,
                        'url': track_url or url,
                        'source': 'spotify',
                    },
                )

            next_value = page.get('next')
            next_url = str(next_value).strip() if isinstance(next_value, str) and next_value.strip() else ''

        return {
            'title': playlist_title,
            'source': 'spotify',
            'tracks': tracks,
            'total': len(tracks),
        }

    def _extract_deezer_playlist_tracks(self, url: str) -> dict[str, Any]:
        playlist_id = extract_deezer_playlist_id(url)
        if not playlist_id:
            raise RuntimeError('Invalid Deezer playlist URL')

        playlist_meta = fetch_json(f'https://api.deezer.com/playlist/{playlist_id}', timeout_seconds=20)
        playlist_title = str(playlist_meta.get('title') or 'Deezer Playlist').strip() if isinstance(playlist_meta, dict) else 'Deezer Playlist'

        tracks: list[dict[str, Any]] = []
        next_url = f'https://api.deezer.com/playlist/{playlist_id}/tracks?limit=100&index=0'
        while next_url:
            page = fetch_json(next_url, timeout_seconds=20)
            if not isinstance(page, dict):
                break
            data = page.get('data')
            if not isinstance(data, list):
                break

            for row in data:
                if not isinstance(row, dict):
                    continue
                title = str(row.get('title') or '').strip() or 'Unknown Title'
                artist_value = row.get('artist')
                artist = 'Unknown Artist'
                if isinstance(artist_value, dict):
                    artist = str(artist_value.get('name') or '').strip() or 'Unknown Artist'
                link = str(row.get('link') or '').strip()

                tracks.append(
                    {
                        'title': title,
                        'artist': artist,
                        'url': link or url,
                        'source': 'deezer',
                    },
                )

            next_value = page.get('next')
            next_url = str(next_value).strip() if isinstance(next_value, str) and next_value.strip() else ''

        return {
            'title': playlist_title,
            'source': 'deezer',
            'tracks': tracks,
            'total': len(tracks),
        }

    def _normalize_playlist_entry(self, entry: dict[str, Any], default_source: str, index: int) -> dict[str, Any] | None:
        source = detect_source(str(entry.get('webpage_url') or entry.get('url') or ''), default_source)
        url = normalize_result_url(entry)
        title = str(entry.get('title') or entry.get('track') or f'Track {index}').strip() or f'Track {index}'
        artist = str(entry.get('artist') or entry.get('uploader') or entry.get('channel') or 'Unknown Artist').strip() or 'Unknown Artist'

        if not url and source == 'youtube' and entry.get('id'):
            url = f"https://www.youtube.com/watch?v={entry['id']}"
        if not url and source in FALLBACK_SOURCES:
            url = str(entry.get('url') or '').strip()
        if not url:
            return None

        return {
            'index': index,
            'title': title,
            'artist': artist,
            'source': source,
            'url': url,
        }

    def _resolve_track_download_target(self, url: str, source: str, title: str, artist: str) -> tuple[str, str, bool]:
        detected_source = detect_source(url, source)
        if detected_source not in FALLBACK_SOURCES:
            return url, detected_source, False

        try:
            mirror_url = self._find_youtube_mirror_url(title, artist)
            return mirror_url, 'youtube', True
        except Exception:
            meta_title, meta_artist = self._extract_track_metadata(url)
            mirror_url = self._find_youtube_mirror_url(meta_title, meta_artist)
            return mirror_url, 'youtube', True

    def _unique_path(self, path: Path) -> Path:
        if not path.exists():
            return path

        base = path.stem
        ext = path.suffix
        counter = 1
        while True:
            candidate = path.with_name(f'{base} ({counter}){ext}')
            if not candidate.exists():
                return candidate
            counter += 1

    def _pick_save_target(self, suggested_filename: str) -> Path | None:
        if self.window is None:
            return None

        filename = sanitize_file_component(Path(suggested_filename).stem, 'download')
        ext = Path(suggested_filename).suffix or '.bin'
        normalized_name = f'{filename}{ext}'

        try:
            import webview  # type: ignore

            result = self.window.create_file_dialog(
                webview.SAVE_DIALOG,
                directory=str(Path.home() / 'Downloads'),
                save_filename=normalized_name,
            )
            if not result:
                return None
            selected = result[0] if isinstance(result, (tuple, list)) else result
            return Path(str(selected)).resolve()
        except Exception as error:
            log(f'File dialog failed: {error}')
            return None

    def _run_download(self, url: str, audio_format: str, audio_quality: str) -> tuple[Path, dict[str, Any]]:
        ytdlp_path = ensure_ytdlp_binary()
        ffmpeg_path = ensure_ffmpeg_binary()

        info = self._extract_media_metadata(url, ytdlp_path)
        work_dir = Path(tempfile.mkdtemp(prefix='sounddrop-desktop-'))
        output_template = str(work_dir / '%(id)s.%(ext)s')

        command = [
            str(ytdlp_path),
            '--no-warnings',
            '--no-playlist',
            '--no-progress',
            '--restrict-filenames',
            '--extractor-args',
            'youtube:player_client=tv,ios,android',
            '--ffmpeg-location',
            str(ffmpeg_path.parent),
            '--format',
            'bestaudio/best',
            '--extract-audio',
            '--audio-format',
            audio_format,
            '--audio-quality',
            audio_quality,
            '--output',
            output_template,
            url,
        ]

        try:
            run_command(command, timeout_seconds=1800)
            output = pick_output_file(work_dir, info)
            return output, info
        except Exception:
            shutil.rmtree(work_dir, ignore_errors=True)
            raise

    def _extract_media_metadata(self, url: str, ytdlp_path: Path) -> dict[str, Any]:
        command = [
            str(ytdlp_path),
            '--skip-download',
            '--no-playlist',
            '--no-warnings',
            '--extractor-args',
            'youtube:player_client=tv,ios,android',
            '--dump-single-json',
            url,
        ]
        raw = run_command(command, timeout_seconds=300)
        lines = [line.strip() for line in raw.splitlines() if line.strip()]
        if not lines:
            raise RuntimeError('yt-dlp did not return metadata')

        for line in reversed(lines):
            try:
                payload = json.loads(line)
            except Exception:
                continue
            if isinstance(payload, dict):
                return payload

        raise RuntimeError('yt-dlp returned invalid metadata payload')

    def _extract_track_metadata(self, url: str) -> tuple[str, str]:
        source = detect_source(url, 'unknown')
        if source == 'spotify':
            spotify_meta = extract_spotify_metadata(url)
            if spotify_meta:
                return spotify_meta

        og_meta = extract_og_metadata(url)
        if og_meta:
            return og_meta

        ytdlp_path = ensure_ytdlp_binary()
        command = [
            str(ytdlp_path),
            '--skip-download',
            '--no-playlist',
            '--extractor-args',
            'youtube:player_client=tv,ios,android',
            '--print',
            '%(track)s|||%(artist)s|||%(title)s|||%(uploader)s',
            url,
        ]
        try:
            raw = run_command(command, timeout_seconds=300)
        except Exception as error:
            raise RuntimeError(f'Could not extract metadata from source URL: {error}') from error

        lines = [line.strip() for line in raw.splitlines() if line.strip()]
        if not lines:
            raise RuntimeError('Could not extract metadata from source URL')

        track, artist, title, uploader = ('', '', '', '')
        parts = lines[-1].split('|||')
        if len(parts) >= 4:
            track, artist, title, uploader = [part.strip() for part in parts[:4]]
        else:
            title = lines[-1]

        resolved_title = track or title
        resolved_artist = artist or uploader
        if not resolved_title and not resolved_artist:
            raise RuntimeError('Source metadata is empty')

        return resolved_title or 'Unknown Title', resolved_artist or 'Unknown Artist'

    def _find_youtube_mirror_url(self, title: str, artist: str) -> str:
        ytdlp_path = ensure_ytdlp_binary()

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

        for candidate in query_variants:
            command = [
                str(ytdlp_path),
                '--skip-download',
                '--no-playlist',
                '--default-search',
                'ytsearch',
                '--print',
                '%(webpage_url)s',
                f'ytsearch1:{candidate}',
            ]
            try:
                raw = run_command(command, timeout_seconds=300)
            except Exception:
                continue
            lines = [line.strip() for line in raw.splitlines() if line.strip()]
            url = next((line for line in lines if line.startswith('http')), '')
            if url:
                return url

        raise RuntimeError('No YouTube mirror found for fallback')


def build_loading_html() -> str:
    return """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SoundDrop Desktop</title>
  <style>
    :root {
      --bg: #080212;
      --bg2: #16072b;
      --line: rgba(255, 132, 228, 0.38);
      --accent: #ff47d6;
      --text: #f8e9ff;
      --muted: #c5a0e8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      color: var(--text);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      background:
        radial-gradient(980px 520px at -8% -18%, rgba(255,71,214,0.3), transparent 62%),
        radial-gradient(960px 620px at 108% 8%, rgba(89,240,255,0.22), transparent 62%),
        linear-gradient(155deg, var(--bg) 0%, var(--bg2) 100%);
    }
    .card {
      width: min(620px, calc(100vw - 36px));
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 28px;
      background:
        linear-gradient(155deg, rgba(33,12,58,0.88), rgba(17,7,32,0.9)),
        repeating-linear-gradient(-30deg, rgba(255,255,255,0.015) 0 2px, rgba(255,255,255,0) 2px 10px);
      box-shadow: 0 24px 55px rgba(6, 1, 14, 0.55);
    }
    .logo {
      display: inline-grid;
      width: 50px;
      height: 50px;
      place-items: center;
      border-radius: 14px;
      border: 1px solid rgba(255,132,228,0.7);
      background: linear-gradient(145deg, rgba(255,71,214,0.28), rgba(89,240,255,0.26));
      color: #ffe8fb;
      font-size: 25px;
    }
    .title {
      margin: 14px 0 4px;
      font-size: 32px;
      line-height: 1;
      letter-spacing: -0.03em;
      font-weight: 700;
      font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    }
    .title span {
      color: #6fffff;
      text-shadow: 0 0 18px rgba(89,240,255,0.42);
    }
    .meta { color: var(--muted); font-size: 14px; }
    .loader {
      margin-top: 20px;
      height: 4px;
      border-radius: 999px;
      background: rgba(141, 98, 214, 0.35);
      overflow: hidden;
    }
    .loader::before {
      content: "";
      display: block;
      width: 42%;
      height: 100%;
      background: linear-gradient(90deg, #ff47d6, #60f4ff);
      animation: slide 1.1s ease-in-out infinite alternate;
    }
    @keyframes slide {
      from { transform: translateX(-20%); }
      to { transform: translateX(180%); }
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">↓</div>
    <div class="title">Sound<span>Drop</span></div>
    <div class="meta">Launching retro sync shell...</div>
    <div class="loader"></div>
  </div>
</body>
</html>"""


def load_target_window(window: Any, url: str) -> None:
    try:
        window.load_url(url)
    except Exception as error:
        log(f'Window load_url failed: {error}')


def main() -> None:
    sync_key = resolve_sync_key()
    language = detect_preferred_language()
    target_url = attach_sync_key(resolve_target_url(), sync_key)
    target_url = attach_launcher_params(target_url, language)
    log(f'Final launch URL: {target_url}')
    try:
        import webview  # type: ignore

        bridge = DesktopBridge()
        window = webview.create_window(
            title='SoundDrop Desktop',
            html=build_loading_html(),
            width=1280,
            height=860,
            min_size=(980, 680),
            background_color='#120526',
            text_select=True,
            resizable=True,
            js_api=bridge,
        )
        bridge.attach_window(window)
        webview.start(load_target_window, window, target_url)
    except Exception as error:
        log(f'PyWebView failed, opening browser instead: {error}')
        webbrowser.open(target_url)


if __name__ == '__main__':
    main()
