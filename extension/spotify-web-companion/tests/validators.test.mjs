import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BACKEND,
  isSpotifyTrackUrl,
  normalizeSettings,
  safeFilename,
  spotifyTrackId,
  spotifyTrackUrl
} from "../utils/validators.js";

test("normalizes Spotify URL and URI", () => {
  assert.equal(spotifyTrackId("spotify:track:4uLU6hMCjMI75M1A2tKUQC"), "4uLU6hMCjMI75M1A2tKUQC");
  assert.equal(
    spotifyTrackUrl("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=test"),
    "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"
  );
  assert.equal(isSpotifyTrackUrl("https://example.com/track/abc"), false);
});

test("uses dyrakarmy.eu as the default backend", () => {
  assert.equal(DEFAULT_BACKEND, "https://dyrakarmy.eu");
  assert.equal(normalizeSettings({}).backendUrl, "https://dyrakarmy.eu");
});

test("sanitizes filenames", () => {
  assert.equal(safeFilename('A/B: "Track"', "mp3"), "A_B_ _Track_.mp3");
});

test("normalizes format and quality", () => {
  assert.deepEqual(
    normalizeSettings({ format: "flac", quality: "320", backendUrl: "https://dyrakarmy.eu/" }),
    {
      format: "flac",
      quality: "best",
      backendUrl: "https://dyrakarmy.eu",
      autoDownload: false,
      saveAs: false
    }
  );
});
