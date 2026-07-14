from __future__ import annotations

import unittest

from external_engines.protected_inputs_demo import DEMO_FIELDS, demo_payload, validate_demo_payload
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


class ProtectedInputsDemoTests(unittest.TestCase):
    def test_demo_payload_is_explicitly_nonfunctional(self) -> None:
        payload = demo_payload()
        self.assertTrue(validate_demo_payload(payload))
        self.assertIs(payload["demo_only"], True)
        self.assertEqual(
            payload["capabilities"],
            {
                "network_access": False,
                "subprocess_execution": False,
                "credential_storage": False,
                "key_loading": False,
                "drm_decryption": False,
            },
        )

    def test_every_sensitive_value_is_an_obvious_placeholder(self) -> None:
        markers = ("DEMO", "EXAMPLE", "PLACEHOLDER", "NOT_SET", "NOT_REAL", "NOT_USED")
        for field, value in DEMO_FIELDS.items():
            with self.subTest(field=field):
                self.assertTrue(any(marker in value.upper() for marker in markers))

    def test_rejects_replaced_placeholder(self) -> None:
        payload = demo_payload()
        payload["fields"]["account_token"] = "plausible-secret-value"  # type: ignore[index]
        self.assertFalse(validate_demo_payload(payload))


if __name__ == "__main__":
    unittest.main()
