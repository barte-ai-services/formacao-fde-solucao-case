"""A implantação: o Worker separado, o deploy só pela esteira e nenhum segredo no mcp/."""

import json
import re
import unittest
from pathlib import Path
from typing import Any

RAIZ = Path(__file__).resolve().parent.parent  # mcp/
REPO = RAIZ.parent
FLUXO = REPO / ".github" / "workflows" / "deploy-mcp.yml"


def wrangler() -> dict[str, Any]:
    texto = (RAIZ / "wrangler.jsonc").read_text(encoding="utf-8")
    sem_comentarios = "\n".join(l for l in texto.splitlines() if not l.strip().startswith("//"))
    return json.loads(sem_comentarios)


class ImplantacaoTest(unittest.TestCase):
    def test_ac1_o_worker_python_separado_com_o_service_binding_da_api(self) -> None:
        """#272/AC-1"""
        config = wrangler()
        self.assertEqual(config["name"], "formacao-fde-solucao-case-mcp")
        self.assertIn("python_workers", config["compatibility_flags"])
        self.assertTrue(config["main"].endswith(".py"))
        self.assertIn({"binding": "API", "service": "formacao-fde-solucao-case-api"}, config["services"])

    def test_ac1_o_deploy_e_so_da_esteira_na_main(self) -> None:
        """#272/AC-1"""
        fluxo = FLUXO.read_text(encoding="utf-8")
        self.assertIn("if: github.ref == 'refs/heads/main'", fluxo)
        self.assertIn("environment: producao", fluxo)
        self.assertIn("working-directory: mcp", fluxo)
        self.assertIn("npx wrangler@4.156.0 deploy", fluxo)
        self.assertIn("python3 -m unittest discover -s mcp/src", fluxo)
        self.assertRegex(fluxo, r"paths:\s*\n\s*- \"mcp/\*\*\"")

    def test_ac7_nenhuma_expressao_do_actions_na_linha_de_comando(self) -> None:
        """#272/AC-7"""
        for linha in FLUXO.read_text(encoding="utf-8").splitlines():
            if linha.strip().startswith(("- run:", "run:")):
                self.assertNotIn("${{", linha)

    def test_ac7_so_os_secrets_do_deploy_aparecem_no_workflow(self) -> None:
        """#272/AC-7"""
        usados = set(re.findall(r"secrets\.([A-Z0-9_]+)", FLUXO.read_text(encoding="utf-8")))
        self.assertEqual(usados, {"BARTE_ACADEMY_CLOUDFLARE_API_TOKEN", "BARTE_ACADEMY_CLOUDFLARE_ACCOUNT_ID"})

    def test_ac7_nenhum_segredo_no_mcp(self) -> None:
        """#272/AC-7"""
        suspeitos = re.compile(r"eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY")
        for caminho in RAIZ.rglob("*"):
            if caminho.is_file() and caminho.suffix in {".py", ".jsonc", ".json", ".md", ".toml"}:
                self.assertIsNone(suspeitos.search(caminho.read_text(encoding="utf-8")), caminho.name)


if __name__ == "__main__":
    unittest.main()
