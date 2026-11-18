"""Tests for the BPMN generator and validator (#2)."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import generate_bpmn  # noqa: E402

DOCS = Path(__file__).resolve().parent.parent / "docs" / "processo"


def reachable(process: generate_bpmn.Process, start: str) -> set[str]:
    edges: dict[str, list[str]] = {}
    for f in process.flows:
        edges.setdefault(f.source, []).append(f.target)
    seen, stack = set(), [start]
    while stack:
        node = stack.pop()
        if node not in seen:
            seen.add(node)
            stack += edges.get(node, [])
    return seen


def path_target(process: generate_bpmn.Process, gateway: str, label: str) -> str:
    return next(f.target for f in process.flows if f.source == gateway and f.name == label)


class GeneratedFilesTest(unittest.TestCase):
    def test_committed_files_match_the_generator(self) -> None:
        for file_name, process in generate_bpmn.OUTPUTS.items():
            committed = (DOCS / file_name).read_text(encoding="utf-8")
            self.assertEqual(committed, generate_bpmn.render(process), f"{file_name} desatualizado: rode scripts/generate_bpmn.py")


class CountMatchTest(unittest.TestCase):
    def test_matching_count_skips_the_approval(self) -> None:
        target = path_target(generate_bpmn.TARGET, "Gateway_CountMatches", "sim, pela regra")
        self.assertEqual(target, "Gateway_DockDecision")


class TargetProcessTest(unittest.TestCase):
    target = generate_bpmn.TARGET

    def test_duplicate_is_blocked_without_waiting_for_the_goods(self) -> None:
        after = reachable(self.target, path_target(self.target, "Gateway_Duplicate", "sim"))
        self.assertIn("End_DuplicateBlocked", after)
        self.assertNotIn("Event_Arrives", after)
        self.assertNotIn("Task_Release", after)

    def test_already_paid_invoice_is_not_paid_again(self) -> None:
        after = reachable(self.target, path_target(self.target, "Gateway_AlreadyPaid", "sim"))
        self.assertIn("End_Regularized", after)
        self.assertNotIn("Task_Release", after)

    def test_title_reaches_the_daily_list_only_after_reconciliation(self) -> None:
        before_release = {f.source for f in self.target.flows if f.target == "Task_Release"}
        self.assertTrue(before_release <= {"Gateway_DockDecision", "Task_AskReturnNote"})

    def test_dock_decision_has_the_three_outcomes(self) -> None:
        labels = {f.name for f in self.target.flows if f.source == "Gateway_DockDecision"}
        self.assertEqual(labels, {"receber", "receber parcial", "recusar"})


if __name__ == "__main__":
    unittest.main()
