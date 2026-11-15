"""Testes do eval contra o gabarito (#227), com um gabarito mínimo e sem ler o do kit."""
import json
import tempfile
import unittest
from pathlib import Path

import avaliar

GABARITO = [
    {"nota_id": "N1", "classificacao": "match", "acao_doca": "receber", "encaminhamento": "regra", "valor_em_risco": 0.0},
    {"nota_id": "N2", "classificacao": "E6", "acao_doca": "recusar", "encaminhamento": "bloqueio", "valor_em_risco": 100.0},
    {"nota_id": "N3", "classificacao": "E4", "acao_doca": "receber_parcial", "encaminhamento": "analista", "valor_em_risco": 50.0},
]


def proposta(nota, cl, acao, enc, risco=None):
    p = {"nota_id": nota, "classificacao": cl, "acao_doca": acao, "encaminhamento": enc}
    if risco is not None:
        p["valor_em_risco"] = risco
    return p


class AvaliarTest(unittest.TestCase):
    def test_acerto_completo_por_campo_e_por_tipo(self):
        props = {
            "N1": proposta("N1", "match", "receber", "regra"),
            "N2": proposta("N2", "E6", "recusar", "diretoria", 100.5),
            "N3": proposta("N3", "E1", "receber_parcial", "analista", 10.0),
        }
        r = avaliar.avaliar(props, GABARITO)
        self.assertEqual(r["completo"], 1)
        self.assertEqual(r["campos"], {"classificacao": 2, "acao_doca": 3, "encaminhamento": 2})
        self.assertEqual(r["por_tipo"]["E6"], {"total": 1, "classificacao": 1, "completo": 0})
        self.assertEqual(r["risco"], (1, 2))
        self.assertEqual(r["confusao"][("E4", "E1")], 1)
        self.assertEqual(len(r["erros"]), 2)

    def test_nota_sem_proposta_conta_como_erro(self):
        r = avaliar.avaliar({}, GABARITO)
        self.assertEqual((r["completo"], r["cobertura"]), (0, 0))
        self.assertEqual(r["confusao"][("E6", "sem proposta")], 1)

    def test_ultima_proposta_da_nota_vale(self):
        with tempfile.TemporaryDirectory() as pasta:
            arq = Path(pasta) / "p.jsonl"
            linhas = [proposta("N1", "E1", "recusar", "bloqueio"), proposta("N1", "match", "receber", "regra")]
            arq.write_text("\n".join(json.dumps(x) for x in linhas) + "\n\n", encoding="utf-8")
            props = avaliar.ler_propostas(arq)
        self.assertEqual(props["N1"]["classificacao"], "match")

    def test_relatorio_compara_com_a_baseline(self):
        ok = {g["nota_id"]: proposta(g["nota_id"], g["classificacao"], g["acao_doca"], g["encaminhamento"]) for g in GABARITO}
        agente = avaliar.avaliar(ok, GABARITO)
        base = avaliar.avaliar({}, GABARITO)
        texto = avaliar.relatorio("agente", agente, ("baseline", base))
        self.assertIn("| Acerto completo (as três skills) | 100% | 0% |", texto)
        self.assertIn("## Confusões mais comuns", avaliar.relatorio("baseline", base))

    def test_gabarito_de_outra_base_e_recusado(self):
        gab = [{"nota_id": "N1", "chave": "A"}, {"nota_id": "N2", "chave": "B"}]
        avaliar.conferir_base(gab, [{"nota_id": "N1", "chave": "A"}, {"nota_id": "N2", "chave": "B"}])
        with self.assertRaises(SystemExit) as erro:
            avaliar.conferir_base(gab, [{"nota_id": "N1", "chave": "A"}, {"nota_id": "N2", "chave": "X"}])
        self.assertIn("1 de 2", str(erro.exception))


if __name__ == "__main__":
    unittest.main()
