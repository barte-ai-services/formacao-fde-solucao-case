"""Gera `src/approval_screen.py` a partir de `ui/approval.html` (#274).

O Python Worker só sobe módulos .py: o HTML da tela vai para dentro de um deles, como literal. A fonte editada é o
HTML; o módulo é gerado, e o teste `approval_screen_test.py` falha se ele estiver desatualizado.

Uso, da raiz do repositório:  python3 mcp/scripts/generate_ui.py"""

from __future__ import annotations

from pathlib import Path

MCP_DIR = Path(__file__).resolve().parent.parent
SOURCE = MCP_DIR / "ui" / "approval.html"
TARGET = MCP_DIR / "src" / "approval_screen.py"

HEADER = '''"""GERADO por mcp/scripts/generate_ui.py a partir de mcp/ui/approval.html. Não edite: edite o HTML e rode o script.

A tela do MCP App da fila (#274), como literal, porque o Python Worker só sobe módulos .py."""

APPROVAL_HTML = '''


def render(html: str) -> str:
    """O texto do módulo: o HTML entre aspas triplas, com a barra invertida e as aspas triplas escapadas."""
    literal = html.replace("\\", "\\\\").replace('"""', '\\"\\"\\"')
    return f'{HEADER}"""{literal}"""\n'


def main() -> None:
    TARGET.write_text(render(SOURCE.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"gerado {TARGET.relative_to(MCP_DIR.parent)}")


if __name__ == "__main__":
    main()
