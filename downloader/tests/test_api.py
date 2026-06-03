import zipfile
from pathlib import Path

from fastapi.testclient import TestClient

from app.main import app


def test_health_endpoint():
  client = TestClient(app)
  response = client.get('/health')
  assert response.status_code == 200
  body = response.json()
  assert body['ok'] is True
  assert body['service'] == 'sounddrop-downloader'


def test_ytdlp_cookiefile_can_be_resolved_from_file(tmp_path, monkeypatch):
  from app import main

  cookie_file = tmp_path / 'cookies.txt'
  cookie_file.write_text('# Netscape HTTP Cookie File\n', encoding='utf-8')
  monkeypatch.setenv('YTDLP_COOKIES_FILE', str(cookie_file))
  monkeypatch.delenv('YTDLP_COOKIES_TEXT', raising=False)
  monkeypatch.delenv('YTDLP_COOKIES_BASE64', raising=False)
  main.YTDLP_COOKIE_CACHE.clear()

  opts = main.apply_ytdlp_cookiefile({})
  assert opts['cookiefile'] == str(cookie_file)


def test_ytdlp_cookiefile_can_be_materialized_from_base64(tmp_path, monkeypatch):
  from app import main
  import base64

  cookie_text = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tFALSE\t0\tSOCS\tvalue\n'
  monkeypatch.setattr(main, 'WORK_DIR', tmp_path)
  monkeypatch.delenv('YTDLP_COOKIES_FILE', raising=False)
  monkeypatch.delenv('YTDLP_COOKIES_TEXT', raising=False)
  monkeypatch.setenv('YTDLP_COOKIES_BASE64', base64.b64encode(cookie_text.encode('utf-8')).decode('ascii'))
  main.YTDLP_COOKIE_CACHE.clear()

  opts = main.apply_ytdlp_cookiefile({})
  cookie_path = Path(opts['cookiefile'])
  assert cookie_path.exists()
  assert cookie_path.read_text(encoding='utf-8') == cookie_text


def test_auth_required_for_internal_routes():
  client = TestClient(app)
  search = client.post('/internal/search', json={'query': 'test'})
  assert search.status_code == 401

  playlist = client.post('/internal/playlist/resolve', json={'url': 'https://youtube.com/playlist?list=abc'})
  assert playlist.status_code == 401

  file_resp = client.get('/internal/files/missing.mp3')
  assert file_resp.status_code == 401


def test_internal_file_returns_404_for_missing_with_auth():
  client = TestClient(app)
  response = client.get('/internal/files/missing.mp3', headers={'X-API-Key': 'change-me'})
  assert response.status_code == 404


def test_internal_file_serves_existing_file(tmp_path, monkeypatch):
  from app import main

  sample = tmp_path / 'sample.mp3'
  sample.write_bytes(b'audio')

  monkeypatch.setattr(main, 'STORAGE_DIR', tmp_path)

  client = TestClient(app)
  response = client.get(f'/internal/files/{sample.name}', headers={'X-API-Key': 'change-me'})

  assert response.status_code == 200
  assert response.content == b'audio'


def test_parse_filename_metadata_prefers_artist_title_pattern():
  from app import main

  title, artist = main.parse_filename_metadata(Path('Audio Influenza - The Storm - RestlessLegsSound Remix.flac'))

  assert artist == 'Audio Influenza'
  assert title == 'The Storm - RestlessLegsSound Remix'


def test_archive_track_uses_filename_when_tags_missing(tmp_path, monkeypatch):
  from app import main

  sample = tmp_path / 'Audio Influenza - The Storm - RestlessLegsSound Remix.flac'
  sample.write_bytes(b'audio')
  monkeypatch.setattr(main, 'ffprobe_metadata', lambda _path: {'format': {}, 'streams': []})

  track = main.archive_track_from_path(sample)

  assert track.artist == 'Audio Influenza'
  assert track.title == 'The Storm - RestlessLegsSound Remix'


def test_playlist_resolve_works_with_mock(monkeypatch):
  from app import main

  def fake_resolve(url: str, source: str):
    return main.PlaylistResolveResponse(
      title='Test Playlist',
      source=source,
      total=1,
      tracks=[
        main.PlaylistTrack(
          title='Song',
          artist='Artist',
          source='youtube',
          url='https://www.youtube.com/watch?v=abc123def45',
        ),
      ],
    )

  monkeypatch.setattr(main, 'resolve_playlist', fake_resolve)

  client = TestClient(app)
  response = client.post(
    '/internal/playlist/resolve',
    json={'url': 'https://www.youtube.com/playlist?list=PL123', 'source': 'youtube'},
    headers={'X-API-Key': 'change-me'},
  )

  assert response.status_code == 200
  body = response.json()
  assert body['title'] == 'Test Playlist'
  assert body['total'] == 1
  assert body['tracks'][0]['source'] == 'youtube'


def test_rss_podcast_resolve(monkeypatch):
  from app import main

  monkeypatch.setattr(
    main,
    'fetch_text',
    lambda *_args, **_kwargs: '''<?xml version="1.0"?>
      <rss version="2.0">
        <channel>
          <title>Test Podcast</title>
          <item>
            <title>Episode One</title>
            <author>Host One</author>
            <enclosure url="https://cdn.example.com/episode-one.mp3" type="audio/mpeg" />
          </item>
        </channel>
      </rss>''',
  )

  resolved = main.resolve_playlist('https://feeds.example.com/podcast.xml', 'podcast')

  assert resolved.source == 'podcast'
  assert resolved.title == 'Test Podcast'
  assert resolved.total == 1
  assert resolved.tracks[0].url == 'https://cdn.example.com/episode-one.mp3'


def test_apple_podcast_resolve(monkeypatch):
  from app import main

  monkeypatch.setattr(
    main,
    'fetch_json',
    lambda *_args, **_kwargs: {
      'results': [
        {'wrapperType': 'track', 'kind': 'podcast', 'collectionName': 'Apple Show'},
        {
          'wrapperType': 'podcastEpisode',
          'trackName': 'Apple Episode',
          'artistName': 'Apple Host',
          'episodeUrl': 'https://cdn.example.com/apple-episode.m4a',
        },
      ],
    },
  )

  resolved = main.resolve_playlist('https://podcasts.apple.com/us/podcast/test/id123456789', 'podcast')

  assert resolved.title == 'Apple Show'
  assert resolved.total == 1
  assert resolved.tracks[0].source == 'podcast'
  assert resolved.tracks[0].url.endswith('apple-episode.m4a')


def test_podcast_search_uses_itunes(monkeypatch):
  from app import main

  monkeypatch.setattr(
    main,
    'fetch_json',
    lambda *_args, **_kwargs: {
      'results': [
        {
          'trackId': 42,
          'trackName': 'Search Episode',
          'collectionName': 'Search Show',
          'episodeUrl': 'https://cdn.example.com/search.mp3',
          'trackTimeMillis': 180000,
          'releaseDate': '2024-01-02T00:00:00Z',
        },
      ],
    },
  )

  client = TestClient(app)
  response = client.post(
    '/internal/search',
    json={'query': 'search show', 'source': 'podcast', 'limit': 3},
    headers={'X-API-Key': 'change-me'},
  )

  assert response.status_code == 200
  body = response.json()
  assert body['results'][0]['source'] == 'podcast'
  assert body['results'][0]['year'] == 2024


def test_playlist_workflow_start_and_status(monkeypatch):
  from app import main
  main.WORKFLOW_STATE.clear()
  main.WORKFLOW_FINGERPRINT_INDEX.clear()

  def fake_run_workflow(workflow_id: str):
    main.update_workflow_state(
      workflow_id,
      status='done',
      phase='finalized',
      total_tracks=2,
      queued_count=2,
      done_count=2,
      processing_count=0,
      failed_count=0,
      deduped_count=0,
      current_batch=1,
      total_batches=1,
      finished_at=main.utc_now_iso(),
    )

  monkeypatch.setattr(main, 'run_playlist_workflow_local', fake_run_workflow)

  client = TestClient(app)
  start = client.post(
    '/internal/playlist/workflow/start',
    json={
      'workflow_id': 'wf-test-1',
      'url': 'https://www.youtube.com/playlist?list=PL123',
      'source': 'youtube',
      'format': 'mp3',
      'quality': '320',
      'batch_size': 25,
    },
    headers={'X-API-Key': 'change-me'},
  )

  assert start.status_code == 200
  body = start.json()
  assert body['workflow_id'] == 'wf-test-1'
  assert body['status'] in {'queued', 'processing', 'done'}

  status = client.get('/internal/playlist/workflow/wf-test-1', headers={'X-API-Key': 'change-me'})
  assert status.status_code == 200
  status_body = status.json()
  assert status_body['workflow_id'] == 'wf-test-1'


def test_internal_smoke_requires_auth():
  client = TestClient(app)
  response = client.post(
    '/internal/smoke',
    json={'url': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'source': 'youtube'},
  )
  assert response.status_code == 401


def test_internal_smoke_success(monkeypatch):
  from app import main

  monkeypatch.setattr(
    main,
    'probe_download_metadata',
    lambda _url: {'title': 'Smoke Song', 'uploader': 'Smoke Artist', 'duration': 101},
  )

  client = TestClient(app)
  response = client.post(
    '/internal/smoke',
    json={
      'url': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'source': 'youtube',
      'format': 'mp3',
      'quality': 'best',
    },
    headers={'X-API-Key': 'change-me'},
  )

  assert response.status_code == 200
  body = response.json()
  assert body['ok'] is True
  assert body['source'] == 'youtube'
  assert body['fallback_used'] is False
  assert body['title'] == 'Smoke Song'


def test_internal_download_accepts_trusted_ytdlp_search_target(monkeypatch, tmp_path):
  from app import main

  source_dir = tmp_path / 'source'
  source_dir.mkdir()
  output = source_dir / 'song.mp3'
  output.write_bytes(b'audio')
  monkeypatch.setattr(main, 'STORAGE_DIR', tmp_path / 'storage')
  monkeypatch.setattr(
    main,
    'run_download',
    lambda _job_id, _url, _format, _quality: (
      output,
      {'title': 'Search Song', 'uploader': 'Search Artist', 'duration': 99},
    ),
  )

  client = TestClient(app)
  response = client.post(
    '/internal/download',
    json={
      'job_id': 'job-search-1',
      'url': 'ytsearch1:Search Artist - Search Song audio',
      'source': 'youtube',
      'format': 'mp3',
      'quality': '320',
    },
    headers={'X-API-Key': 'change-me'},
  )

  assert response.status_code == 200
  body = response.json()
  assert body['source'] == 'youtube'
  assert body['title'] == 'Search Song'
  assert body['download_url'].endswith('.mp3')


def test_internal_preview_success(monkeypatch):
  from app import main

  monkeypatch.setattr(
    main,
    'extract_preview_info',
    lambda _query, _source: main.PreviewResponse(
      title='Preview Song',
      artist='Preview Artist',
      duration=123,
      thumbnail='https://example.com/thumb.jpg',
      preview_url='https://example.com/audio.m4a',
      source='youtube',
      resolved_url='https://www.youtube.com/watch?v=abc123def45',
      fallback_used=False,
    ),
  )

  client = TestClient(app)
  response = client.post(
    '/internal/preview',
    json={'query': 'Preview Artist - Preview Song', 'source': 'youtube'},
    headers={'X-API-Key': 'change-me'},
  )

  assert response.status_code == 200
  body = response.json()
  assert body['title'] == 'Preview Song'
  assert body['preview_url'].endswith('/audio.m4a')
  assert body['fallback_used'] is False


def test_internal_metadata_lookup_success(monkeypatch):
  from app import main

  monkeypatch.setattr(
    main,
    'lookup_musicbrainz_metadata',
    lambda _query, _limit: main.MetadataLookupResponse(
      results=[
        main.MetadataLookupItem(
          id='mb-1',
          title='Metadata Song',
          artist='Metadata Artist',
          album='Metadata Album',
          release_date='2020-01-01',
          year='2020',
          country='BG',
          type='Single',
          duration=180000,
          score=99,
        ),
      ],
    ),
  )

  client = TestClient(app)
  response = client.post(
    '/internal/metadata/lookup',
    json={'query': 'Metadata Artist - Metadata Song', 'limit': 3},
    headers={'X-API-Key': 'change-me'},
  )

  assert response.status_code == 200
  body = response.json()
  assert body['results'][0]['title'] == 'Metadata Song'
  assert body['results'][0]['year'] == '2020'


def test_internal_artist_discography_success(monkeypatch):
  from app import main

  monkeypatch.setattr(
    main,
    'fetch_json',
    lambda *_args, **_kwargs: {
      'recordings': [
        {
          'title': 'First Song',
          'artist-credit': [{'artist': {'name': 'Discography Artist'}}],
        },
        {
          'title': 'First Song',
          'artist-credit': [{'artist': {'name': 'Discography Artist'}}],
        },
        {
          'title': 'Second Song',
          'artist-credit': [{'artist': {'name': 'Discography Artist'}}],
        },
      ],
    },
  )

  client = TestClient(app)
  response = client.post(
    '/internal/artist/discography',
    json={'artist': 'Discography Artist', 'limit': 10},
    headers={'X-API-Key': 'change-me'},
  )

  assert response.status_code == 200
  body = response.json()
  assert body['title'] == 'Discography Artist Discography'
  assert body['total'] == 2
  assert body['tracks'][0]['url'].startswith('ytsearch1:')
  assert body['tracks'][0]['source'] == 'youtube'


def test_internal_artist_discography_falls_back_when_metadata_provider_fails(monkeypatch):
  from app import main

  monkeypatch.setattr(main, 'fetch_json', lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError('SSL EOF')))
  monkeypatch.setattr(
    main,
    'make_ydl_search',
    lambda _query, _limit: [
      main.SearchItem(
        id='yt-1',
        title='Fallback Song',
        artist='Fallback Artist',
        duration=123,
        source='youtube',
        url='https://www.youtube.com/watch?v=abc123def45',
      ),
      main.SearchItem(
        id='yt-1-dup',
        title='Fallback Song',
        artist='Fallback Artist',
        duration=123,
        source='youtube',
        url='https://www.youtube.com/watch?v=abc123def45',
      ),
    ],
  )

  client = TestClient(app)
  response = client.post(
    '/internal/artist/discography',
    json={'artist': 'Fallback Artist', 'limit': 10},
    headers={'X-API-Key': 'change-me'},
  )

  assert response.status_code == 200
  body = response.json()
  assert body['title'] == 'Fallback Artist Discography'
  assert body['total'] == 1
  assert body['tracks'][0]['title'] == 'Fallback Song'
  assert body['tracks'][0]['url'] == 'https://www.youtube.com/watch?v=abc123def45'


def test_internal_smoke_fallback_for_spotify(monkeypatch):
  from app import main

  monkeypatch.setattr(main, 'extract_track_metadata', lambda _url: ('Fallback Song', 'Fallback Artist'))
  monkeypatch.setattr(main, 'find_youtube_mirror_url', lambda _title, _artist: 'https://www.youtube.com/watch?v=abc123def45')
  monkeypatch.setattr(
    main,
    'probe_download_metadata',
    lambda _url: {'title': 'Fallback Song', 'uploader': 'Fallback Artist', 'duration': 201},
  )

  client = TestClient(app)
  response = client.post(
    '/internal/smoke',
    json={
      'url': 'https://open.spotify.com/track/5msPBVPfpNMt36L9hsPD0B',
      'source': 'spotify',
      'format': 'mp3',
      'quality': 'best',
    },
    headers={'X-API-Key': 'change-me'},
  )

  assert response.status_code == 200
  body = response.json()
  assert body['ok'] is True
  assert body['source'] == 'youtube'
  assert body['fallback_used'] is True
  assert body['resolved_url'].startswith('https://www.youtube.com/watch')


def test_playlist_workflow_pause_resume_cancel(monkeypatch):
  from app import main
  main.WORKFLOW_STATE.clear()
  main.WORKFLOW_FINGERPRINT_INDEX.clear()

  monkeypatch.setattr(main, 'run_playlist_workflow_local', lambda _workflow_id: None)

  client = TestClient(app)
  start = client.post(
    '/internal/playlist/workflow/start',
    json={
      'workflow_id': 'wf-control-1',
      'url': 'https://www.youtube.com/playlist?list=PL123',
      'source': 'youtube',
      'format': 'mp3',
      'quality': '320',
    },
    headers={'X-API-Key': 'change-me'},
  )
  assert start.status_code == 200

  pause = client.post('/internal/playlist/workflow/wf-control-1/pause', headers={'X-API-Key': 'change-me'})
  assert pause.status_code == 200
  assert pause.json()['control_state'] == 'paused'

  resume = client.post('/internal/playlist/workflow/wf-control-1/resume', headers={'X-API-Key': 'change-me'})
  assert resume.status_code == 200
  assert resume.json()['control_state'] == 'active'

  cancel = client.post('/internal/playlist/workflow/wf-control-1/cancel', headers={'X-API-Key': 'change-me'})
  assert cancel.status_code == 200
  assert cancel.json()['control_state'] == 'cancelled'


def test_playlist_zip_build(monkeypatch, tmp_path):
  from app import main

  monkeypatch.setattr(main, 'STORAGE_DIR', tmp_path)

  class _FakeStream:
    def __enter__(self):
      return self

    def __exit__(self, exc_type, exc, tb):
      return False

    def read(self):
      return b'audio-bytes'

  monkeypatch.setattr(main.urllib.request, 'urlopen', lambda *_args, **_kwargs: _FakeStream())

  client = TestClient(app)
  response = client.post(
    '/internal/playlist/zip',
    json={
      'workflow_id': 'wf-zip-1',
      'source': 'youtube',
      'files': [
        {
          'job_id': 'job-1',
          'title': 'Song 1',
          'artist': 'Artist 1',
          'format': 'mp3',
          'download_url': 'https://example.com/f1.mp3',
        },
        {
          'job_id': 'job-2',
          'title': 'Song 2',
          'artist': 'Artist 2',
          'format': 'mp3',
          'download_url': 'https://example.com/f2.mp3',
        },
      ],
    },
    headers={'X-API-Key': 'change-me'},
  )

  assert response.status_code == 200
  body = response.json()
  assert body['file_count'] == 2
  archive_name = Path(body['download_url']).name
  assert (tmp_path / archive_name).exists()


def test_archive_browse_returns_folders_and_images(monkeypatch, tmp_path):
  from app import main

  nested = tmp_path / 'Photos'
  nested.mkdir()
  image = nested / 'cover.jpg'
  image.write_bytes(b'\xff\xd8\xff\xd9')

  monkeypatch.setattr(main, 'ARCHIVE_DIRS_RAW', str(tmp_path))

  client = TestClient(app)
  root_response = client.get('/internal/archive/browse', headers={'X-API-Key': 'change-me'})
  assert root_response.status_code == 200
  root_body = root_response.json()
  assert any(item['kind'] == 'folder' and item['name'] == 'Photos' for item in root_body['items'])

  nested_response = client.get(
    '/internal/archive/browse?path=Photos',
    headers={'X-API-Key': 'change-me'},
  )
  assert nested_response.status_code == 200
  nested_body = nested_response.json()
  image_items = [item for item in nested_body['items'] if item['kind'] == 'image']
  assert image_items
  assert image_items[0]['format'] == 'JPG'

  file_response = client.get(
    f"/internal/archive/files/{main.archive_file_id(image)}",
    headers={'X-API-Key': 'change-me'},
  )
  assert file_response.status_code == 200
  assert file_response.content == b'\xff\xd8\xff\xd9'


def test_archive_pack_falls_back_to_zip_when_7z_missing(monkeypatch, tmp_path):
  from app import main

  first = tmp_path / 'Artist - One.flac'
  second = tmp_path / 'Artist - Two.mp3'
  first.write_bytes(b'one')
  second.write_bytes(b'two')

  monkeypatch.setattr(main, 'ARCHIVE_DIRS_RAW', str(tmp_path))
  monkeypatch.setattr(main, 'STORAGE_DIR', tmp_path)
  monkeypatch.setattr(main, 'WORK_DIR', tmp_path)
  monkeypatch.setattr(main, 'find_7z_binary', lambda: None)
  main.ARCHIVE_CACHE['items'] = []
  main.ARCHIVE_CACHE['created_at'] = 0
  main.ARCHIVE_PATH_INDEX.clear()

  client = TestClient(app)
  response = client.post(
    '/internal/archive/pack',
    json={
      'file_ids': [main.archive_file_id(first), main.archive_file_id(second)],
      'archive_format': '7z',
      'title': 'telegram-selected',
    },
    headers={'X-API-Key': 'change-me'},
  )

  assert response.status_code == 200
  body = response.json()
  assert body['file_count'] == 2
  assert body['archive_format'] == 'zip'
  assert body['requested_format'] == '7z'
  assert body['fallback_used'] is True

  archive_path = tmp_path / Path(body['download_url']).name
  assert archive_path.exists()
  with zipfile.ZipFile(archive_path) as zf:
    names = zf.namelist()
  assert any(name.endswith('Artist - One.flac') for name in names)
  assert any(name.endswith('Artist - Two.mp3') for name in names)
