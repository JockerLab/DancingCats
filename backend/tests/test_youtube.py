import unittest

from dancing_cats_backend.youtube import extract_video_id


class ExtractVideoIdTests(unittest.TestCase):
    def test_supported_urls(self):
        expected = "_VvPjfjOpxE"
        for url in (
            "https://www.youtube.com/watch?v=_VvPjfjOpxE",
            "https://www.youtube.com/shorts/_VvPjfjOpxE",
            "https://youtu.be/_VvPjfjOpxE",
        ):
            with self.subTest(url=url):
                self.assertEqual(extract_video_id(url), expected)

    def test_rejects_unsupported_urls(self):
        for url in (
            "http://www.youtube.com/watch?v=_VvPjfjOpxE",
            "https://example.com/watch?v=_VvPjfjOpxE",
            "https://www.youtube.com/playlist?list=abc",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                extract_video_id(url)


if __name__ == "__main__":
    unittest.main()
