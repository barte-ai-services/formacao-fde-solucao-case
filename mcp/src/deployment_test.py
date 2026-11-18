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

    def test_ac1_o_worker_sobe_sem_o_sdk_externo_e_com_data_que_o_wrangler_travado_aceita(self) -> None:  # ADR-002
        """#272/AC-1: sem pacotes de terceiros, só `disable_python_external_sdk` deixa o Worker subir; 2026-10-30 é o
        limite do workerd do lockfile (2026-10-31 é recusada)."""
        config = wrangler_config()
        self.assertIn("disable_python_external_sdk", config["compatibility_flags"])
        self.assertLessEqual(config["compatibility_date"], "2026-10-30")

    def test_ac6_a_observabilidade_liga_so_os_logs_e_deixa_invocation_logs_e_traces_desligados(self) -> None:  # ADR-002
        """#272/AC-6: o que o Worker registra (só campos nomeados) chega ao painel; os invocation logs e os traces
        ficam desligados porque poderiam registrar o cabeçalho Cf-Access-Jwt-Assertion (DAT-1)."""
        self.assertEqual(
            wrangler_config()["observability"],
            {"enabled": True, "logs": {"enabled": True, "invocation_logs": False}},
        )

    def test_ac6_o_motivo_dos_traces_e_dos_invocation_logs_desligados_esta_comentado_no_arquivo(self) -> None:  # ADR-002
        """#272/AC-6"""
        lines = (MCP_DIR / "wrangler.jsonc").read_text(encoding="utf-8").splitlines()
        at = next(i for i, line in enumerate(lines) if '"observability"' in line)
        comment = lines[at - 1].strip().lower()
        self.assertTrue(comment.startswith("//"))
        for term in ("traces", "invocation logs", "cf-access-jwt-assertion"):
            self.assertIn(term, comment)

    def test_ac7_a_lista_de_origens_permitidas_e_uma_variavel_vazia_por_padrao(self) -> None:  # ADR-002
        """#272/AC-7: vazia, qualquer Origin presente é recusado; o plano 3 (#275) ajusta se preciso."""
        self.assertEqual(wrangler_config()["vars"], {"MCP_ALLOWED_ORIGINS": ""})



class WorkflowTest(unittest.TestCase):
    def workflow(self) -> str:
        return WORKFLOW.read_text(encoding="utf-8")

    def test_ac1_o_deploy_e_so_da_esteira_na_main(self) -> None:  # ADR-002
        """#272/AC-1"""
        text = self.workflow()
        self.assertIn("if: github.ref == 'refs/heads/main'", text)
        self.assertIn("environment: producao", text)
        self.assertIn("working-directory: mcp", text)
        self.assertIn("npx wrangler deploy", text)
        self.assertNotIn("wrangler@", text)
        self.assertIn("python3 -m unittest discover -s mcp/src", text)
        self.assertRegex(text, r"paths:\s*\n\s*- \"mcp/\*\*\"")

    def steps(self) -> list[str]:
        return self.workflow().split("\n      - ")[1:]

    def test_ac7_as_dependencias_instalam_do_lockfile_num_passo_sem_secrets(self) -> None:  # ADR-002
        """#272/AC-7 e SUP-1: o `npm ci` roda sem scripts de instalação e sem nenhum secret no ambiente."""
        installs = [step for step in self.steps() if "npm ci" in step]
        self.assertEqual(len(installs), 1)
        self.assertIn("working-directory: mcp", installs[0])
        self.assertIn("npm ci --ignore-scripts", installs[0])
        for forbidden in ("secrets.", "CLOUDFLARE", "env:"):
            self.assertNotIn(forbidden, installs[0])

    def test_ac7_o_deploy_usa_o_wrangler_instalado_e_so_ele_ve_as_credenciais(self) -> None:  # ADR-002
        """#272/AC-7 e SUP-1: o wrangler vem do node_modules travado, não de um `npx` que resolve a árvore na hora."""
        steps = self.steps()
        deploys = [step for step in steps if "wrangler deploy" in step]
        self.assertEqual(len(deploys), 1)
        self.assertIn("CLOUDFLARE_API_TOKEN: ${{ secrets.BARTE_ACADEMY_CLOUDFLARE_API_TOKEN }}", deploys[0])
        self.assertIn("CLOUDFLARE_ACCOUNT_ID: ${{ secrets.BARTE_ACADEMY_CLOUDFLARE_ACCOUNT_ID }}", deploys[0])
        self.assertEqual([step for step in steps if "secrets." in step], deploys)
        install = next(i for i, step in enumerate(steps) if "npm ci" in step)
        self.assertLess(install, steps.index(deploys[0]))

    def test_ac7_o_node_vem_do_setup_node_com_cache_do_lockfile_do_mcp(self) -> None:  # ADR-002
        """#272/AC-7"""
        setup = next(step for step in self.steps() if "actions/setup-node@" in step)
        self.assertRegex(setup, r"actions/setup-node@[0-9a-f]{40} # v4")
        self.assertIn("cache: npm", setup)
        self.assertIn("cache-dependency-path: mcp/package-lock.json", setup)

    def test_ac7_nenhuma_expressao_do_actions_na_linha_de_comando(self) -> None:  # ADR-002
        """#272/AC-7"""
        for line in self.workflow().splitlines():
            if line.strip().startswith(("- run:", "run:")):
                self.assertNotIn("${{", line)

    def test_ac7_so_os_secrets_do_deploy_aparecem_no_workflow(self) -> None:  # ADR-002
        """#272/AC-7"""
        used = set(re.findall(r"secrets\.([A-Z0-9_]+)", self.workflow()))
        self.assertEqual(used, {"BARTE_ACADEMY_CLOUDFLARE_API_TOKEN", "BARTE_ACADEMY_CLOUDFLARE_ACCOUNT_ID"})



class LockedDependenciesTest(unittest.TestCase):
    def package(self) -> JsonObject:
        return json.loads((MCP_DIR / "package.json").read_text(encoding="utf-8"))

    def lock_packages(self) -> JsonObject:
        return json.loads((MCP_DIR / "package-lock.json").read_text(encoding="utf-8"))["packages"]

    def test_ac7_so_o_wrangler_e_o_jsdom_do_teste_da_tela_sao_dependencias_e_tem_versao_exata(self) -> None:  # ADR-002
        """#272/AC-7 e SUP-1; #274: o jsdom roda o teste da tela (mcp/ui), nunca o Worker."""
        package = self.package()
        self.assertEqual(self.lock_packages()[""]["devDependencies"], package["devDependencies"])
        self.assertTrue(package["private"])
        self.assertEqual(package["devDependencies"], {"jsdom": "31.0.1", "wrangler": "4.156.0"})
        self.assertNotIn("dependencies", package)

    def test_ac7_o_lockfile_trava_a_arvore_inteira_com_integridade(self) -> None:  # ADR-002
        """#272/AC-7 e SUP-1"""
        packages = self.lock_packages()
        self.assertEqual(packages["node_modules/wrangler"]["version"], "4.156.0")
        unlocked = [name for name, entry in packages.items() if name and "integrity" not in entry and not entry.get("link")]
        self.assertEqual(unlocked, [])

    def test_ac7_o_node_modules_nao_vai_para_o_git(self) -> None:  # ADR-002
        """#272/AC-7"""
        self.assertIn("node_modules/", (REPO_DIR / ".gitignore").read_text(encoding="utf-8").splitlines())
        self.assertEqual(self.package()["name"], "formacao-fde-solucao-case-mcp")


class NoSecretsTest(unittest.TestCase):
    def test_ac7_nenhum_segredo_no_mcp(self) -> None:  # ADR-002
        """#272/AC-7"""
        suspects = re.compile(r"eyJ[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY")
        for path in MCP_DIR.rglob("*"):
            if path.is_file() and path.suffix in {".py", ".jsonc", ".json", ".md", ".toml"}:
                self.assertIsNone(suspects.search(path.read_text(encoding="utf-8")), path.name)


if __name__ == "__main__":
    unittest.main()
