import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import patch

from dancing_cats_backend.youtube import download_audio, extract_video_id


class ExtractVideoIdTests(unittest.TestCase):
    def test_supported_urls(self):
        expected = "_VvPjfjOpxE"
        for url in (
            "https://www.youtube.com/watch?v=_VvPjfjOpxE",
            "https://youtu.be/_VvPjfjOpxE",
        ):
            with self.subTest(url=url):
                self.assertEqual(extract_video_id(url), expected)

    def test_rejects_unsupported_urls(self):
        for url in (
            "http://www.youtube.com/watch?v=_VvPjfjOpxE",
            "https://example.com/watch?v=_VvPjfjOpxE",
            "https://www.youtube.com/playlist?list=abc",
            "https://www.youtube.com/shorts/_VvPjfjOpxE",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                extract_video_id(url)

    def test_retries_download_with_android_client(self):
        class DownloadError(Exception):
            pass

        attempts = []

        class FakeYoutubeDL:
            def __init__(self, options):
                self.options = options
                attempts.append(options)

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def extract_info(self, _url, *, download):
                self.download = download
                if len(attempts) == 1:
                    raise DownloadError("HTTP Error 403: Forbidden")
                return {"id": "_VvPjfjOpxE", "title": "Test", "duration": 12}

            def prepare_filename(self, _info):
                return self.options["outtmpl"].replace("%(ext)s", "mp4")

        fake_module = SimpleNamespace(
            YoutubeDL=FakeYoutubeDL,
            utils=SimpleNamespace(DownloadError=DownloadError),
        )
        completed = SimpleNamespace(returncode=0, stderr="")
        with TemporaryDirectory() as temporary, patch.dict(
            "sys.modules", {"yt_dlp": fake_module}
        ), patch("dancing_cats_backend.youtube.subprocess.run", return_value=completed):
            result = download_audio(
                "https://www.youtube.com/watch?v=_VvPjfjOpxE",
                Path(temporary),
                900,
            )

        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0]["source_address"], "0.0.0.0")
        self.assertEqual(
            attempts[1]["extractor_args"]["youtube"]["player_client"],
            ["android"],
        )
        self.assertEqual(result.video_id, "_VvPjfjOpxE")


if __name__ == "__main__":
    unittest.main()
