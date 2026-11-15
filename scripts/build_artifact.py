"""Builds the process page published as a claude.ai artifact (#2): the template with the two
BPMN files and the diagram stylesheet inlined.

    python3 scripts/build_artifact.py
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FOLDER = ROOT / "artifacts" / "process"


def build() -> str:
    page = (FOLDER / "template.html").read_text(encoding="utf-8")
    replacements = {
        "__DIAGRAM_CSS__": (FOLDER / "diagram-js.css").read_text(encoding="utf-8"),
        "__XML_ATUAL__": (ROOT / "docs" / "processo" / "processo-atual.bpmn").read_text(encoding="utf-8"),
        "__XML_ALVO__": (ROOT / "docs" / "processo" / "processo-alvo.bpmn").read_text(encoding="utf-8"),
    }
    for marker, content in replacements.items():
        page = page.replace(marker, content)
    return page


if __name__ == "__main__":
    (FOLDER / "index.html").write_text(build(), encoding="utf-8")
    print(f"gerado {FOLDER / 'index.html'}")
