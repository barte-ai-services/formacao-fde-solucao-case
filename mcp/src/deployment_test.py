"""A implantação: o Worker separado, o deploy só pela esteira e nenhum segredo no mcp/."""

import json
import re
import unittest
from pathlib import Path

from json_types import JsonObject

MCP_DIR = Path(__file__).resolve().parent.parent  # #272 a pasta mcp/
REPO_DIR = MCP_DIR.parent
WORKFLOW = REPO_DIR / ".github" / "workflows" / "deploy-mcp.yml"


def wrangler_config() -> JsonObject:
    text = (MCP_DIR / "wrangler.jsonc").read_text(encoding="utf-8")
    without_comments = "\n".join(line for line in text.splitlines() if not line.strip().startswith("//"))
    return json.loads(without_comments)


class WranglerConfigTest(unittest.TestCase):
    def test_ac1_o_worker_python_separado_com_o_service_binding_da_api(self) -> None:  # ADR-002
        """#272/AC-1"""
        config = wrangler_config()
        self.assertEqual(config["name"], "formacao-fde-solucao-case-mcp")
        self.assertIn("python_workers", config["compatibility_flags"])
        self.assertTrue(config["main"].endswith(".py"))
        self.assertIn({"binding": "API", "service": "formacao-fde-solucao-case-api"}, config["services"])



class WorkflowTest(unittest.TestCase):
    def workflow(self) -> str:
        return WORKFLOW.read_text(encoding="utf-8")

    def test_ac1_o_deploy_e_so_da_esteira_na_main(self) -> None:  # ADR-002
        """#272/AC-1"""
        text = self.workflow()
        self.assertIn("if: github.ref == 'refs/heads/main'", text)
        self.assertIn("environment: producao", text)
        self.assertIn("working-directory: mcp", text)
        self.assertIn("npx wrangler@4.156.0 deploy", text)
        self.assertIn("python3 -m unittest discover -s mcp/src", text)
        self.assertRegex(text, r"paths:\s*\n\s*- \"mcp/\*\*\"")

    def test_ac7_nenhuma_expressao_do_actions_na_linha_de_comando(self) -> None:  # ADR-002
        """#272/AC-7"""
        for line in self.workflow().splitlines():
            if line.strip().startswith(("- run:", "run:")):
                self.assertNotIn("${{", line)

    def test_ac7_so_os_secrets_do_deploy_aparecem_no_workflow(self) -> None:  # ADR-002
        """#272/AC-7"""
        used = set(re.findall(r"secrets\.([A-Z0-9_]+)", self.workflow()))
        self.assertEqual(used, {"BARTE_ACADEMY_CLOUDFLARE_API_TOKEN", "BARTE_ACADEMY_CLOUDFLARE_ACCOUNT_ID"})



class NoSecretsTest(unittest.TestCase):
    def test_ac7_nenhum_segredo_no_mcp(self) -> None:  # ADR-002
        """#272/AC-7"""
        suspects = re.compile(r"eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY")
        for path in MCP_DIR.rglob("*"):
            if path.is_file() and path.suffix in {".py", ".jsonc", ".json", ".md", ".toml"}:
                self.assertIsNone(suspects.search(path.read_text(encoding="utf-8")), path.name)


if __name__ == "__main__":
    unittest.main()
