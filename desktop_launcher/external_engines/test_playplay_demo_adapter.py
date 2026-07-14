from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from external_engines.playplay_demo_adapter import (
    CAPABILITIES,
    build_demo_payload,
    save_demo_payload,
    validate_demo_payload,
    validate_spotify_reference,
)


class PlayPlayDemoAdapterTests(unittest.TestCase):
    def test_accepts_public_spotify_track_url(self) -> None:
        value = "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b"
        self.assertEqual(validate_spotify_reference(value), value)

    def test_rejects_non_spotify_input(self) -> None:
        with self.assertRaises(ValueError):
            validate_spotify_reference("https://example.com/private-stream")

    def test_payload_is_non_executable(self) -> None:
        payload = build_demo_payload(
            "spotify:track:0VjIjW4GlUZAMYd2vXMi3b",
            320,
        )
        self.assertTrue(validate_demo_payload(payload))
        self.assertTrue(all(value is False for value in CAPABILITIES.values()))
        self.assertIn("DEMO", str(payload["command_preview"][0]).upper())

    def test_rejects_replaced_cookie_placeholder(self) -> None:
        payload = build_demo_payload(
            "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b",
            160,
        )
        payload["config_preview"]["cookies_path"] = "C:/playplay/cookies.txt"
        self.assertFalse(validate_demo_payload(payload))

    def test_export_requires_demo_suffix(self) -> None:
        payload = build_demo_payload(
            "https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b",
            96,
        )
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            saved = save_demo_payload(root / "playplay.demo.json", payload)
            self.assertTrue(saved.is_file())
            with self.assertRaises(ValueError):
                save_demo_payload(root / "playplay.json", payload)


if __name__ == "__main__":
    unittest.main()
