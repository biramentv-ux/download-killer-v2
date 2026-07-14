from __future__ import annotations

import unittest

from external_engines.spotify_oggmp4_gui import SPOTIFY_INPUT_RE


class SpotifyInputValidationTests(unittest.TestCase):
    def test_public_track_url(self) -> None:
        self.assertIsNotNone(
            SPOTIFY_INPUT_RE.fullmatch(
                "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b"
            )
        )

    def test_playlist_uri(self) -> None:
        self.assertIsNotNone(
            SPOTIFY_INPUT_RE.fullmatch(
                "spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"
            )
        )

    def test_bare_id(self) -> None:
        self.assertIsNotNone(
            SPOTIFY_INPUT_RE.fullmatch("0VjIjW4GlUZAMYd2vXMi3b")
        )

    def test_rejects_unrelated_input(self) -> None:
        self.assertIsNone(SPOTIFY_INPUT_RE.fullmatch("not-a-spotify-reference"))


if __name__ == "__main__":
    unittest.main()
