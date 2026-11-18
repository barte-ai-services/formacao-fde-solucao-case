"""A tela do MCP App chega ao Worker sem passo manual (#274): o módulo gerado tem de acompanhar o HTML."""

import importlib.util
import re
import unittest
from pathlib import Path
from types import ModuleType

import approval_screen

MCP_DIR = Path(__file__).resolve().parent.parent
SOURCE = MCP_DIR / "ui" / "approval.html"
GENERATOR = MCP_DIR / "scripts" / "generate_ui.py"


def load_generator() -> ModuleType:
    spec = importlib.util.spec_from_file_location("generate_ui", GENERATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class GeneratedModuleTest(unittest.TestCase):
    def test_ac1_o_modulo_gerado_tem_o_mesmo_html_da_fonte(self) -> None:  # ADR-002
        """#274/AC-1: se falhar, rode `python3 mcp/scripts/generate_ui.py` e comite o resultado."""
        self.assertEqual(approval_screen.APPROVAL_HTML, SOURCE.read_text(encoding="utf-8"))

    def test_ac1_o_arquivo_do_modulo_e_exatamente_o_que_o_gerador_escreve(self) -> None:  # ADR-002
        """#274/AC-1"""
        generator = load_generator()
        expected = generator.render(SOURCE.read_text(encoding="utf-8"))
        self.assertEqual(generator.TARGET.read_text(encoding="utf-8"), expected)

    def test_o_literal_resiste_a_barras_e_aspas_triplas(self) -> None:  # ADR-002
        generator = load_generator()
        html = 'a\\nb "x" """ \\d+ \\\\ fim'
        scope: dict[str, str] = {}
        exec(generator.render(html), scope)
        self.assertEqual(scope["APPROVAL_HTML"], html)


class SelfContainedTest(unittest.TestCase):
    """#274: a tela não busca nada da rede e traz a própria política de conteúdo."""

    def setUp(self) -> None:
        self.html = approval_screen.APPROVAL_HTML

    def test_traz_uma_csp_restritiva_no_proprio_html(self) -> None:  # ADR-002
        match = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]+)"', self.html)
        self.assertIsNotNone(match, "falta a CSP no HTML")
        policy = match.group(1) if match else ""
        self.assertIn("default-src 'none'", policy)
        self.assertNotRegex(policy, r"https?:")
        self.assertNotIn("*", policy)

    def test_nao_referencia_nenhum_recurso_externo(self) -> None:  # ADR-002
        for forbidden in ("<link", "@import", "<script src", "<img", "<iframe", "fetch(", "XMLHttpRequest", "WebSocket"):
            self.assertNotIn(forbidden, self.html, forbidden)
        self.assertNotRegex(self.html, r"""(?:src|href)\s*=\s*["']?https?:""")
        self.assertNotRegex(self.html, r"url\(\s*[\"']?(?:https?:)?//")

    def test_nao_escreve_texto_de_tool_por_innerhtml(self) -> None:  # ADR-002
        for forbidden in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function"):
            self.assertNotIn(forbidden, self.html, forbidden)


if __name__ == "__main__":
    unittest.main()
