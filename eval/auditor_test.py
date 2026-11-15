"""Testes do eval do auditor (#239), com um gabarito mínimo e sem ler o do kit."""
import contextlib
import io
import json
import re
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import auditor

# Registro e Json: o que vem do JSONL ou do gabarito só tem forma conhecida em execução, por isso `Any`.
Json = Any
Registro = dict[str, Json]

RAIZ = Path(__file__).resolve().parent.parent

GABARITO = [
    {"nota_id": "N1", "chave": "K1", "classificacao": "match", "acao_doca": "receber", "encaminhamento": "regra"},
    {"nota_id": "N2", "chave": "K2", "classificacao": "E6", "acao_doca": "recusar", "encaminhamento": "bloqueio"},
    {"nota_id": "N3", "chave": "K3", "classificacao": "E4", "acao_doca": "receber_parcial", "encaminhamento": "analista"},
]

REGRA_RUIM = {"classification": "MATCH", "dock_action": "receber", "routing": "regra"}


def linha(chave: str, cl: str, acao: str, rot: str, **extra: Json) -> Registro:
    base = {
        "invoice_access_key": chave,
        "classification": cl,
        "dock_action": acao,
        "routing": rot,
        "justification": "porque sim",
        "amount_at_risk": None,
        "model": "modelo-a",
        "audited_at": "2026-11-15T10:00:00Z",
        "rule": REGRA_RUIM,
    }
    base.update(extra)
    return base


def todas_certas() -> list[Registro]:
    return [
        linha("K1", "MATCH", "receber", "regra"),
        linha("K2", "E6", "recusar", "bloqueio"),
        linha("K3", "E4", "receber_parcial", "analista"),
    ]


AGORA = datetime(2026, 11, 15, 12, 0, 0, tzinfo=timezone.utc)


def executar(argv: list[str], agora: datetime = AGORA) -> tuple[int, str, str]:
    saida, erro = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(saida), contextlib.redirect_stderr(erro):
        codigo = auditor.main(argv, agora=lambda: agora)
    return codigo, saida.getvalue(), erro.getvalue()


class MedicaoTest(unittest.TestCase):
    def medir(self, linhas: list[Registro], gabarito: list[Registro] | None = None) -> Registro:
        return auditor.medir(linhas, GABARITO if gabarito is None else gabarito)

    def test_ac1_devolve_todos_os_campos_do_relatorio(self) -> None:
        """#239/AC-1: o relatório traz os campos do contrato."""
        r = self.medir(todas_certas())
        for campo in ("model", "prompt_version", "full_match_rate", "by_field", "by_exception",
                      "routing_below_regua", "first_try_routing_rate", "errors", "vs_baseline"):
            self.assertIn(campo, r)
        self.assertEqual(r["model"], "modelo-a")
        self.assertIsNone(r["prompt_version"])
        self.assertEqual(r["full_match_rate"], 1.0)
        self.assertEqual(r["by_field"], {"classification": 1.0, "dock_action": 1.0, "routing": 1.0})
        self.assertEqual(r["by_exception"]["E6"], {"total": 1, "classification": 1, "dock_action": 1, "routing": 1, "full": 1})
        self.assertEqual(r["by_exception"]["E1"]["total"], 0)
        self.assertEqual(r["errors"], [])

    def test_ac1_denominador_e_o_das_80_notas_do_gabarito(self) -> None:
        """#239/AC-1: a taxa é sobre todas as notas do gabarito."""
        gab = [{"nota_id": f"N{i}", "chave": f"K{i}", "classificacao": "match", "acao_doca": "receber",
                "encaminhamento": "regra"} for i in range(80)]
        linhas = [linha(f"K{i}", "MATCH", "receber", "regra") for i in range(20)]
        r = self.medir(linhas, gab)
        self.assertEqual(r["notes_total"], 80)
        self.assertEqual(r["full_match_rate"], 0.25)
        self.assertEqual(len(r["errors"]), 60)

    def test_ac1_acerto_por_campo_e_modelos_distintos_ordenados(self) -> None:
        """#239/AC-1: acerto por campo, e model/prompt_version distintos saem ordenados."""
        linhas = todas_certas()
        linhas[2] = linha("K3", "E1", "receber_parcial", "diretoria", model="modelo-b", prompt_version="v2")
        linhas[0]["prompt_version"] = "v1"
        r = self.medir(linhas)
        self.assertEqual(r["model"], ["modelo-a", "modelo-b"])
        self.assertEqual(r["prompt_version"], ["v1", "v2"])
        self.assertAlmostEqual(r["by_field"]["classification"], 2 / 3)
        self.assertAlmostEqual(r["by_field"]["dock_action"], 1.0)
        self.assertAlmostEqual(r["by_field"]["routing"], 2 / 3)
        self.assertAlmostEqual(r["full_match_rate"], 2 / 3)
        self.assertEqual(r["by_exception"]["E4"]["full"], 0)
        self.assertEqual(r["by_exception"]["E4"]["dock_action"], 1)

    def test_ac1_nota_sem_auditoria_nota_nao_auditada_e_chave_fora_do_gabarito(self) -> None:
        """#239/AC-1: faltante e não auditada são erro; chave fora do gabarito não muda o denominador."""
        linhas = [
            linha("K1", "MATCH", "receber", "regra"),
            linha("K3", "E4", "receber_parcial", "analista", not_audited={"reason": "sem XML"}),
            linha("KX", "E1", "recusar", "bloqueio"),
        ]
        r = self.medir(linhas)
        self.assertEqual(r["notes_total"], 3)
        self.assertAlmostEqual(r["full_match_rate"], 1 / 3)
        por_chave = {e["invoice_access_key"]: e["reason"] for e in r["errors"]}
        self.assertEqual(por_chave["K2"], "sem auditoria")
        self.assertEqual(por_chave["K3"], "não auditada: sem XML")
        self.assertIn("KX", por_chave)
        self.assertEqual(r["by_exception"]["E4"]["full"], 0)

    def test_ac1_nao_catalogada_nunca_e_acerto_e_ultima_linha_da_chave_vale(self) -> None:
        """#239/AC-1: NAO_CATALOGADA erra; a mesma chave duas vezes vale a última."""
        linhas = todas_certas() + [linha("K1", "NAO_CATALOGADA", "receber", "regra")]
        r = self.medir(auditor.deduplicar(linhas))
        self.assertEqual(r["by_exception"]["match"]["classification"], 0)
        self.assertEqual(r["by_exception"]["match"]["full"], 0)

    def test_ac5_vs_baseline_por_excecao_agente_contra_regra(self) -> None:
        """#239/AC-5: por exceção, o acerto do agente contra o da regra sem IA."""
        r = self.medir(todas_certas())
        vb = r["vs_baseline"]
        self.assertEqual(vb["by_exception"]["match"]["agent_full"], 1.0)
        self.assertEqual(vb["by_exception"]["match"]["rule_full"], 1.0)
        self.assertEqual(vb["by_exception"]["E6"]["agent_full"], 1.0)
        self.assertEqual(vb["by_exception"]["E6"]["rule_full"], 0.0)
        self.assertEqual(vb["by_exception"]["E6"]["agent_classification"], 1.0)
        self.assertEqual(vb["by_exception"]["E6"]["rule_classification"], 0.0)
        self.assertIsNone(vb["by_exception"]["E1"]["agent_full"])
        self.assertAlmostEqual(vb["total"]["agent_full"], 1.0)
        self.assertAlmostEqual(vb["total"]["rule_full"], 1 / 3)

    def test_ac6_sem_recusas_no_arquivo_as_metricas_sao_nao_medido(self) -> None:
        """#239/AC-6: sem `refusals` no arquivo, as duas métricas são null, nunca 0."""
        r = self.medir(todas_certas())
        self.assertIsNone(r["routing_below_regua"])
        self.assertIsNone(r["first_try_routing_rate"])
        self.assertIn("não medido", auditor.relatorio_md(dict(r, run_id="x"), None))

    def test_ac6_com_recusas_conta_abaixo_da_regua_e_acerto_de_primeira(self) -> None:
        """#239/AC-6: com `refusals`, contam as recusas de alçada e as linhas sem recusa."""
        linhas = todas_certas()
        linhas[0]["refusals"] = []
        linhas[1]["refusals"] = [{"refusal": "routing_below_regua"}, {"refusal": "invalid_field"}]
        linhas[2]["refusals"] = [{"refusal": "routing_below_regua"}]
        r = self.medir(linhas)
        self.assertEqual(r["routing_below_regua"], 2)
        self.assertAlmostEqual(r["first_try_routing_rate"], 1 / 3)

    def test_ac4_e6_perdida_barra_e_e6_certa_nao(self) -> None:
        """#239/AC-4: E6 do gabarito não classificada E6 (inclusive ausente ou não auditada) barra."""
        self.assertFalse(auditor.e6_perdida(self.medir(todas_certas())))
        errada = todas_certas()
        errada[1] = linha("K2", "E1", "recusar", "bloqueio")
        self.assertTrue(auditor.e6_perdida(self.medir(errada)))
        self.assertTrue(auditor.e6_perdida(self.medir([todas_certas()[0]])))
        nao_aud = todas_certas()
        nao_aud[1] = linha("K2", "E6", "recusar", "bloqueio", not_audited={"reason": "x"})
        self.assertTrue(auditor.e6_perdida(self.medir(nao_aud)))

    def test_ac3_diferenca_contra_a_rodada_anterior(self) -> None:
        """#239/AC-3: a diferença traz full_match_rate, por campo e por exceção."""
        anterior = self.medir(todas_certas())
        pior = todas_certas()
        pior[2] = linha("K3", "E1", "receber_parcial", "analista")
        atual = self.medir(pior)
        d = auditor.diferenca(atual, dict(anterior, run_id="antes"))
        self.assertEqual(d["previous_run_id"], "antes")
        self.assertAlmostEqual(d["full_match_rate"], -1 / 3)
        self.assertAlmostEqual(d["by_field"]["classification"], -1 / 3)
        self.assertEqual(d["by_field"]["routing"], 0.0)
        self.assertEqual(d["by_exception"]["E4"], -1.0)
        self.assertIsNone(d["by_exception"]["E1"])

    def test_ac3_run_id_e_deterministico_e_ordenavel(self) -> None:
        """#239/AC-3: o run_id é timestamp UTC mais hash curto do conteúdo."""
        a = auditor.gerar_run_id(AGORA, b"abc")
        self.assertEqual(a, auditor.gerar_run_id(AGORA, b"abc"))
        self.assertRegex(a, r"^20261115T120000Z-[0-9a-f]{8}$")
        self.assertNotEqual(a, auditor.gerar_run_id(AGORA, b"abd"))
        mais_tarde = auditor.gerar_run_id(datetime(2026, 11, 16, tzinfo=timezone.utc), b"abc")
        self.assertGreater(mais_tarde, a)


class ComandoTest(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.pasta = Path(self._tmp.name)
        self.gabarito = self.pasta / "gabarito.json"
        self.gabarito.write_text(json.dumps(GABARITO), encoding="utf-8")
        self.rodadas = self.pasta / "rodadas"

    def escrever(self, linhas: list[Registro], nome: str = "auditorias.jsonl") -> str:
        arq = self.pasta / nome
        arq.write_text("\n".join(json.dumps(x) for x in linhas) + "\n\n", encoding="utf-8")
        return str(arq)

    def rodar(self, linhas: list[Registro], *extra: str, agora: datetime = AGORA, nome: str = "auditorias.jsonl") -> tuple[int, str, str]:
        argv = [self.escrever(linhas, nome), "--gabarito", str(self.gabarito), "--rodadas", str(self.rodadas), *extra]
        return executar(argv, agora)

    def test_ac1_imprime_o_json_da_rodada_e_sai_zero(self) -> None:
        """#239/AC-1: por padrão, o comando imprime a rodada em JSON e sai 0."""
        codigo, saida, _ = self.rodar(todas_certas())
        self.assertEqual(codigo, 0)
        rodada = json.loads(saida)
        self.assertEqual(rodada["full_match_rate"], 1.0)
        self.assertRegex(rodada["run_id"], r"^20261115T120000Z-[0-9a-f]{8}$")
        self.assertIsNone(rodada["routing_below_regua"])

    def test_ac3_grava_a_rodada_e_compara_com_a_anterior(self) -> None:
        """#239/AC-3: grava eval/rodadas/<run_id>.json e mostra a diferença contra a anterior."""
        _, saida1, _ = self.rodar(todas_certas())
        id1 = json.loads(saida1)["run_id"]
        self.assertTrue((self.rodadas / f"{id1}.json").is_file())
        self.assertNotIn("vs_previous", json.loads(saida1))
        pior = todas_certas()
        pior[2] = linha("K3", "E1", "receber_parcial", "analista")
        depois = datetime(2026, 11, 15, 13, 0, 0, tzinfo=timezone.utc)
        _, saida2, _ = self.rodar(pior, agora=depois, nome="outro.jsonl")
        rodada2 = json.loads(saida2)
        self.assertEqual(rodada2["vs_previous"]["previous_run_id"], id1)
        self.assertAlmostEqual(rodada2["vs_previous"]["full_match_rate"], -1 / 3)
        gravada = json.loads((self.rodadas / f"{rodada2['run_id']}.json").read_text(encoding="utf-8"))
        self.assertEqual(gravada["run_id"], rodada2["run_id"])
        self.assertEqual(len(list(self.rodadas.glob("*.json"))), 2)

    def test_ac3_relatorio_markdown_mostra_a_diferenca_e_a_regra(self) -> None:
        """#239/AC-3 e #239/AC-5: o Markdown traz a diferença e a tabela contra a regra."""
        self.rodar(todas_certas())
        depois = datetime(2026, 11, 15, 13, 0, 0, tzinfo=timezone.utc)
        codigo, saida, _ = self.rodar(todas_certas()[:2], "--formato", "md", agora=depois, nome="b.jsonl")
        self.assertEqual(codigo, 0)
        self.assertIn("## Contra a rodada anterior", saida)
        self.assertIn("## Agente contra a regra sem IA", saida)
        self.assertIn("| E6 |", saida)
        self.assertIn("Erros", saida)

    def test_ac4_e6_perdida_sai_diferente_de_zero_com_o_resto_certo(self) -> None:
        """#239/AC-4: uma E6 perdida faz o comando sair 1, mesmo com todo o resto certo."""
        linhas = todas_certas()
        linhas[1] = linha("K2", "E1", "recusar", "bloqueio")
        codigo, saida, erro = self.rodar(linhas)
        self.assertEqual(codigo, 1)
        self.assertEqual(json.loads(saida)["by_field"]["dock_action"], 1.0)
        self.assertIn("E6", erro)

    def test_entrada_invalida_sai_dois(self) -> None:
        """Arquivo inexistente ou linha que não é JSON é erro de uso: código 2."""
        codigo, _, erro = executar(["nao-existe.jsonl", "--gabarito", str(self.gabarito), "--rodadas", str(self.rodadas)])
        self.assertEqual(codigo, 2)
        self.assertTrue(erro)
        ruim = self.pasta / "ruim.jsonl"
        ruim.write_text("{nao é json\n", encoding="utf-8")
        codigo, _, _ = executar([str(ruim), "--gabarito", str(self.gabarito), "--rodadas", str(self.rodadas)])
        self.assertEqual(codigo, 2)


class SemLeituraDoGabaritoPeloAgenteTest(unittest.TestCase):
    def setUp(self) -> None:
        self.raiz = RAIZ

    def test_ac2_nada_do_agente_nem_da_web_le_o_gabarito(self) -> None:
        """#239/AC-2: nenhum arquivo de api/ e web/src referencia o caminho do gabarito."""
        achados = []
        for raiz in (self.raiz / "api", self.raiz / "web" / "src"):
            for arq in raiz.rglob("*"):
                if not arq.is_file() or "node_modules" in arq.parts or arq.suffix in {".png", ".ico", ".woff2", ".jpg"}:
                    continue
                texto = arq.read_text(encoding="utf-8", errors="ignore")
                if re.search(r"eval/gabarito|gabarito\.json", texto):
                    achados.append(str(arq.relative_to(self.raiz)))
        self.assertEqual(achados, [])

    def test_ac2_o_comando_so_le_o_arquivo_e_o_gabarito(self) -> None:
        """#239/AC-2: o módulo não importa rede nem a base do kit."""
        fonte = (self.raiz / "eval" / "auditor.py").read_text(encoding="utf-8")
        for proibido in ("urllib", "requests", "socket", "http.client", "jachegou", "data/kit"):
            self.assertNotIn(proibido, fonte)


class RodadasIgnoradasTest(unittest.TestCase):
    def test_ac3_rodadas_nao_entram_no_git(self) -> None:
        """#239/AC-3: eval/rodadas/ está no .gitignore."""
        self.assertIn("eval/rodadas/", (RAIZ / ".gitignore").read_text(encoding="utf-8").splitlines())


if __name__ == "__main__":
    unittest.main()
