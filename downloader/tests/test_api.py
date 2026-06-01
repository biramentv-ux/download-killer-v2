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
