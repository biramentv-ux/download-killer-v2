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
