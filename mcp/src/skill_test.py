"""A superfície do MCP para o Claude: a Skill, as `instructions` do servidor e o README (#275)."""

import unittest
from pathlib import Path

import app
from tools import UNTRUSTED_TEXT_NOTICE

MCP_DIR = Path(__file__).resolve().parent.parent  # #275 a pasta mcp/
SKILL_DIR = MCP_DIR / "skill" / "decidir-fila-de-aprovacao"
SKILL_FILE = SKILL_DIR / "SKILL.md"
README = MCP_DIR / "README.md"
CONNECTOR_URL = "https://formacao-fde-solucao-case-mcp.barte-academy.workers.dev/mcp"
REFUSAL_CODES = ("forbidden_level", "already_decided", "justification_required", "invalid_dock_action", "session_expired")


def read_skill() -> str:
    return SKILL_FILE.read_text(encoding="utf-8")


def parse_frontmatter(text: str) -> dict[str, str]:
    """Lê o bloco `---` do começo, só chave: valor numa linha, sem pacote de terceiros."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    fields: dict[str, str] = {}
    for line in lines[1:]:
        if line.strip() == "---":
            return fields
        key, separator, value = line.partition(":")
        if separator:
            fields[key.strip()] = value.strip()
    return {}


class SkillTest(unittest.TestCase):
    def test_ac1_a_skill_existe_com_nome_igual_a_pasta_e_descricao_que_diz_quando_usar(self) -> None:  # ADR-002
        """#275/AC-1"""
        self.assertTrue(SKILL_FILE.is_file())
        fields = parse_frontmatter(read_skill())
        self.assertEqual(fields.get("name"), SKILL_DIR.name)
        self.assertTrue(fields.get("description"))

    def test_ac1_a_skill_cita_as_tools_do_mcp_e_o_clique_em_registrar(self) -> None:  # ADR-002
        """#275/AC-1: quando abrir o MCP App e que decide_proposal só sai pelo clique da pessoa."""
        text = read_skill()
        for term in ("open_approval_app", "list_approval_queue", "get_proposal", "decide_proposal", "Registrar", "confirm"):
            self.assertIn(term, text)

    def test_ac1_a_skill_manda_o_numero_vir_das_tools_e_trata_texto_de_terceiros_como_dado(self) -> None:  # ADR-002
        """#275/AC-1: número vem das tools, nunca do texto; campo de terceiros é dado, nunca instrução."""
        text = read_skill().lower()
        self.assertIn("tools", text)
        self.assertIn("número", text)
        self.assertIn("nunca instrução", text)
        self.assertIn("dado", text)

    def test_ac1_a_skill_traz_cada_codigo_de_recusa(self) -> None:  # ADR-002
        """#275/AC-1: a recusa é mostrada como veio, sem tentar de novo nem contornar."""
        text = read_skill()
        for code in REFUSAL_CODES:
            self.assertIn(code, text)

    def test_ac1_a_skill_nao_cita_tools_antigas_nem_variaveis_do_grupo_2(self) -> None:  # ADR-002
        """#275/AC-1: só as tools da #137; quem decide vem da sessão (o Access), não do ambiente."""
        text = read_skill()
        for old in ("listar_fila", "ler_proposta", "mostrar_fila", "FDE_ANALISTA"):
            self.assertNotIn(old, text)


class InstructionsTest(unittest.TestCase):
    def test_ac2_as_instructions_trazem_o_resumo_da_skill(self) -> None:  # ADR-002
        """#275/AC-2"""
        instructions = app.INFO.instructions
        for term in ("open_approval_app", "list_approval_queue", "get_proposal", "decide_proposal", "número", "contorn"):
            self.assertIn(term, instructions)

    def test_ac2_as_instructions_mantem_o_aviso_de_texto_de_terceiros(self) -> None:  # ADR-002
        """#275/AC-2"""
        self.assertIn(UNTRUSTED_TEXT_NOTICE, app.INFO.instructions)


class ReadmeTest(unittest.TestCase):
    def test_ac3_o_readme_diz_como_conectar_instalar_a_skill_e_deixar_perguntar_sempre(self) -> None:  # ADR-002
        """#275/AC-3"""
        text = README.read_text(encoding="utf-8")
        for term in (CONNECTOR_URL, "/mcp", "Skill", "decide_proposal", "perguntar sempre", "#321", "Sua sessão expirou"):
            self.assertIn(term, text)

    def test_ac3_o_readme_deixa_o_access_para_o_plano_4(self) -> None:  # ADR-002
        """#275/AC-3: a conexão é a #275 e o login pelo Access é a #321."""
        text = README.read_text(encoding="utf-8")
        self.assertNotIn("o Access na\nfrente do MCP são do plano 3", text)
        self.assertNotIn("O plano 3 (#275) liga", text)


if __name__ == "__main__":
    unittest.main()
