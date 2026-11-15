"""Tests for the artifact page builder (#2)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import build_artifact  # noqa: E402


class ArtifactTest(unittest.TestCase):
    def test_committed_page_matches_the_builder(self) -> None:
        committed = (build_artifact.FOLDER / "index.html").read_text(encoding="utf-8")
        self.assertEqual(committed, build_artifact.build(), "index.html desatualizado: rode scripts/build_artifact.py")


if __name__ == "__main__":
    unittest.main()
