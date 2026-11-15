"""Tests for the BPMN validator (#2)."""

import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import validar_bpmn  # noqa: E402

DOCS = Path(__file__).resolve().parent.parent / "docs" / "processo"


class ValidatorTest(unittest.TestCase):
    def test_flow_pointing_to_a_lane_fails(self) -> None:
        xml = (DOCS / "processo-alvo.bpmn").read_text(encoding="utf-8")
        broken = xml.replace('targetRef="Task_Capture"', 'targetRef="Lane_Dock"', 1)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "quebrado.bpmn"
            path.write_text(broken, encoding="utf-8")
            self.assertTrue(validar_bpmn.check(path))

    def test_missing_file_fails(self) -> None:
        self.assertEqual(validar_bpmn.main(["docs/processo/nao-existe.bpmn"]), 1)
        self.assertEqual(validar_bpmn.main([]), 1)


if __name__ == "__main__":
    unittest.main()
