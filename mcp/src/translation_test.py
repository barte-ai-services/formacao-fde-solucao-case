"""A tradução da resposta da API (camelCase) para a saída das tools da #137 (snake_case)."""

import unittest
from typing import Optional

import translation
from json_types import JsonObject, JsonValue
from test_support import KEY, OTHER_KEY, approval_body, money, proposal_body, queue_line


class SnakeTest(unittest.TestCase):
    def test_camel_case_vira_snake_case(self) -> None:  # ADR-002
        self.assertEqual(translation.to_snake("generatedAt"), "generated_at")
        self.assertEqual(translation.to_snake("status"), "status")


class HourInSaoPauloTest(unittest.TestCase):
    def hour(self, value: JsonValue) -> Optional[str]:
        return translation.hour_in_sao_paulo(value)

    def test_instante_utc_vira_a_hora_de_brasilia(self) -> None:  # ADR-002
        self.assertEqual(self.hour("2026-11-18T13:12:40.000Z"), "10h12")

    def test_o_que_nao_e_instante_e_nulo(self) -> None:  # ADR-002
        for value in (None, 12, "ontem"):
            self.assertIsNone(self.hour(value))

    def test_ac5_valor_so_com_a_data_nao_tem_hora(self) -> None:  # ADR-002
        """#272/AC-5: converter 2026-11-18 como meia-noite UTC daria 21h00 do dia anterior, que é falso."""
        self.assertIsNone(self.hour("2026-11-18"))


class QueueTest(unittest.TestCase):
    def body(self) -> JsonObject:
        items = [queue_line(), queue_line(invoiceAccessKey=OTHER_KEY, canApprove=False, classification="E5", level="diretoria")]
        return {"approver": {"email": "ana@exemplo.com", "level": "analista", "x": 1}, "items": items}

    def test_mine_so_traz_o_que_a_pessoa_decide(self) -> None:  # ADR-002
        output = translation.queue(self.body(), "mine", None, None)
        self.assertEqual([i["invoice_access_key"] for i in output["items"]], [KEY])
        self.assertEqual(output["approver"], {"email": "ana@exemplo.com", "level": "analista"})

    def test_all_com_filtros_escolhe_linhas_sem_recalcular(self) -> None:  # ADR-002
        output = translation.queue(self.body(), "all", ("E5",), ("diretoria",))
        self.assertEqual([i["classification"] for i in output["items"]], ["E5"])

    def test_corpo_fora_do_contrato_e_value_error(self) -> None:  # ADR-002
        bodies: list[JsonValue] = [None, {"approver": {}}, {"items": []}]
        for body in bodies:
            with self.assertRaises(ValueError):
                translation.queue(body, "all", None, None)
        self.assertEqual(translation.queue(self.body(), "all", None, None)["items"][1]["level"], "diretoria")

    def test_dossie_e_motor_ficam_desconhecidos_na_fila(self) -> None:  # ADR-002
        """#272/AC-3: GET /api/fila não traz o dossiê; o valor real vem em get_proposal."""
        item = translation.queue(self.body(), "all", None, None)["items"][0]
        self.assertIsNone(item["dossier_status"])
        self.assertIsNone(item["engine"])

    def test_a_linha_nomeia_os_campos_e_nao_repassa_o_resto(self) -> None:  # ADR-002
        item = translation.queue_item(queue_line(segredo="nao-sai"))
        self.assertEqual(translation.queue(self.body(), "mine", None, None)["items"][0]["amount_at_risk"], money(141856))
        self.assertNotIn("segredo", item)
        self.assertNotIn("issuedOn", item)


class DecisionMomentTest(unittest.TestCase):
    def moment(self, body: JsonObject) -> Optional[str]:
        return translation.decision_moment(body)

    def test_o_evento_decisao_da_linha_do_tempo_vence(self) -> None:  # ADR-002
        body = proposal_body("2026-11-18T13:12:40Z", approval=approval_body())
        self.assertEqual(self.moment(body), "2026-11-18T13:12:40Z")

    def test_sem_o_evento_cai_no_dia_gravado_na_aprovacao(self) -> None:  # ADR-002
        self.assertEqual(self.moment(proposal_body(approval=approval_body())), "2026-11-18")

    def test_sem_aprovacao_nem_evento_nao_ha_momento(self) -> None:  # ADR-002
        self.assertIsNone(self.moment(proposal_body()))


class ProposalTest(unittest.TestCase):
    def output(self, **fields: JsonValue) -> JsonObject:
        return translation.proposal(proposal_body(**fields))

    def test_traz_a_aprovacao_com_a_decisao_do_estado(self) -> None:  # ADR-002
        output = self.output(decided_at="2026-11-18T13:12:40Z", approval=approval_body(), state="alterada")
        self.assertEqual(output["approval"]["decision"], "change")
        self.assertEqual(output["approval"]["decided_at"], "2026-11-18T13:12:40Z")
        self.assertEqual(output["approval"]["decided_hour"], "10h12")  # #274 a hora que a tela mostra vem da tool

    def test_o_motor_so_repassa_os_campos_conhecidos(self) -> None:  # ADR-002
        self.assertNotIn("segredo_interno", self.output()["engine"])

    def test_o_dossie_pronto_so_repassa_os_campos_conhecidos(self) -> None:  # ADR-002
        dossier = {
            "status": "ready", "summary": "resumo", "generatedAt": "2026-11-18T13:00:00Z", "campoDesconhecido": "x",
            "requestedBy": "ana@exemplo.com", "model": "m", "supplierHistory": [],
            "divergences": [{
                "classification": "c", "exceptionName": "nome", "whatDiverges": "o que", "outroCampo": "y",
                "evidence": [{"key": "k", "label": "l", "value": "v", "source": "s", "campoNovo": "z"}],
            }],
        }
        output = self.output(dossier=dossier)["dossier"]
        self.assertEqual(output["summary"], "resumo")
        self.assertEqual(output["divergences"][0]["classification_name"], "nome")
        self.assertEqual(output["divergences"][0]["evidence"][0]["label"], "l")
        for name in ("campo_desconhecido", "campoDesconhecido", "requested_by", "model"):
            self.assertNotIn(name, output)
        self.assertNotIn("outro_campo", output["divergences"][0])
        self.assertNotIn("campo_novo", output["divergences"][0]["evidence"][0])
        self.assertNotIn("campoNovo", output["divergences"][0]["evidence"][0])

    def test_o_dossie_em_geracao_nao_leva_quem_pediu(self) -> None:  # ADR-002
        dossier = {"status": "generating", "trigger": "t", "requestedAt": "2026-11-18T13:00:00Z", "requestedBy": "ana@exemplo.com"}
        self.assertEqual(
            self.output(dossier=dossier)["dossier"],
            {"status": "generating", "trigger": "t", "requested_at": "2026-11-18T13:00:00Z"},
        )

    def test_a_auditoria_so_repassa_os_campos_conhecidos(self) -> None:  # ADR-002
        audit = {
            "status": "done", "classification": "c", "amountAtRisk": {"cents": 100, "text": "R$ 1,00", "extra": 1},
            "injectionFlag": False, "model": "m", "campoDesconhecido": "x",
        }
        output = self.output(audit=audit)["audit"]
        self.assertEqual(output["amount_at_risk"], {"cents": 100, "text": "R$ 1,00"})
        self.assertEqual(output["injection_flag"], False)
        for name in ("model", "campo_desconhecido", "campoDesconhecido"):
            self.assertNotIn(name, output)

    def test_a_concordancia_e_as_recusas_so_repassam_os_campos_conhecidos(self) -> None:  # ADR-002, #272
        audit = {
            "status": "done",
            "agreement": {"agrees": False, "differs": ["a", 3], "campoNovo": "x"},
            "refusals": [{"refusal": "r", "field": "f", "minimumLevel": 2, "campoNovo": "y"}],
        }
        output = self.output(audit=audit)["audit"]
        self.assertEqual(output["agreement"], {"agrees": False, "differs": ["a"]})
        self.assertEqual(output["refusals"], [{"refusal": "r", "field": "f", "minimum_level": 2}])

    def test_o_clef_so_repassa_os_campos_conhecidos(self) -> None:  # ADR-002, #272
        clef = {
            "outcome": "o", "confidence": 0.9, "model_version": "v", "reason": "r",
            "decided_at": "2026-11-18T13:00:00Z", "agreement": True, "campoNovo": "x", "segredo_interno": "y",
        }
        output = self.output(engine={"mode": "m", "clef": clef})["engine"]["clef"]
        self.assertEqual(output["model_version"], "v")
        for name in ("campoNovo", "campo_novo", "segredo_interno"):
            self.assertNotIn(name, output)

    def test_corpo_que_nao_e_objeto_e_value_error(self) -> None:  # ADR-002
        with self.assertRaises(ValueError):
            translation.proposal([])
        self.assertEqual(self.output()["invoice_access_key"], KEY)


class RecordedDecisionTest(unittest.TestCase):
    def record(self, body: JsonObject) -> JsonObject:
        return translation.recorded_decision(body, "approve")

    def test_devolve_a_aprovacao_gravada_e_o_estado_do_titulo(self) -> None:  # ADR-002
        output = self.record({"approval": approval_body("ana@exemplo.com"), "title": {"state": "na_lista_do_dia"}})
        self.assertEqual((output["approval"]["decision"], output["title_state"]), ("approve", "na_lista_do_dia"))
        self.assertIsNone(output["approval"]["decided_hour"])  # #274 a API só grava o dia: sem hora, a tela não inventa

    def test_sem_aprovacao_ou_titulo_e_value_error(self) -> None:  # ADR-002
        with self.assertRaises(ValueError):
            self.record({"approval": approval_body()})


class QueueSummaryTest(unittest.TestCase):
    """#274/AC-5: a contagem e o valor em risco do cabeçalho da fila vêm da tool; a tela não soma."""

    def body(self) -> JsonObject:
        items = [
            queue_line(amountAtRisk=money(141856)),
            queue_line(invoiceAccessKey=OTHER_KEY, amountAtRisk=money(26362), classification="E3"),
            queue_line(invoiceAccessKey="3" * 44, amountAtRisk=money(500000), canApprove=False, level="diretoria"),
        ]
        return {"approver": {"email": "ana@exemplo.com", "level": "analista"}, "items": items}

    def test_conta_e_soma_so_o_que_a_pessoa_decide(self) -> None:  # ADR-002
        summary = translation.queue(self.body(), "mine", None, None)["waiting_for_you"]
        self.assertEqual(summary, {"count": 2, "amount_at_risk": {"cents": 168218, "text": "R$ 1.682,18"}})

    def test_nao_muda_com_o_escopo_nem_com_os_filtros(self) -> None:  # ADR-002
        expected = translation.queue(self.body(), "mine", None, None)["waiting_for_you"]
        self.assertEqual(translation.queue(self.body(), "all", None, None)["waiting_for_you"], expected)
        self.assertEqual(translation.queue(self.body(), "all", ("E5",), ("diretoria",))["waiting_for_you"], expected)

    def test_fila_vazia_diz_zero(self) -> None:  # ADR-002
        body: JsonObject = {"approver": {"email": None, "level": None}, "items": []}
        summary = translation.queue(body, "mine", None, None)["waiting_for_you"]
        self.assertEqual(summary, {"count": 0, "amount_at_risk": {"cents": 0, "text": "R$ 0,00"}})

    def test_o_texto_do_dinheiro_agrupa_milhares_e_centavos(self) -> None:  # ADR-002
        self.assertEqual(translation.money_text(8431020), "R$ 84.310,20")
        self.assertEqual(translation.money_text(5), "R$ 0,05")
        self.assertEqual(translation.money_text(123456789), "R$ 1.234.567,89")


def partial_proposal(divergences: list[JsonObject], items: Optional[list[JsonObject]] = None) -> JsonObject:
    base_items = [
        {"supplierCode": "A1", "sku": "S1", "description": "Arroz 5kg", "quantity": {"amount": 10, "unit": "UN"}},
        {"supplierCode": "A2", "sku": "S2", "description": "Feijão 1kg", "quantity": {"amount": 5, "unit": "CX"}},
    ]
    return translation.proposal(proposal_body(divergences=divergences, items=items or base_items))


def divergence(classification: str, skus: list[str], *descriptions: str) -> JsonObject:
    evidence = [{"source": "wms", "reference": "r", "description": d} for d in descriptions]
    return {"classification": classification, "exceptionName": "n", "skus": skus, "evidence": evidence}


class ProposedPartialLinesTest(unittest.TestCase):
    """#274/AC-3: as linhas que a regra propõe para o receber parcial, no lugar da tela (porte de partial-prefill.ts da web)."""

    def lines(self, divergences: list[JsonObject], items: Optional[list[JsonObject]] = None) -> JsonValue:
        return partial_proposal(divergences, items)["proposed_partial_lines"]

    def test_e3_devolve_a_diferenca_da_contagem(self) -> None:  # ADR-002
        found = self.lines([divergence("E3", ["S1"], "Contado 7 UN de 10 UN: Arroz 5kg")])
        self.assertEqual(found, [{"sku": "S1", "quantity": {"amount": 3, "unit": "UN"}, "disposition": "devolver"}])

    def test_e3_decimal_sai_arredondado(self) -> None:  # ADR-002
        found = self.lines([divergence("E3", ["S1"], "Contado 1.2 UN de 1.5 UN: Arroz 5kg")])
        self.assertEqual(found, [{"sku": "S1", "quantity": {"amount": 0.3, "unit": "UN"}, "disposition": "devolver"}])

    def test_contagem_malformada_nao_derruba_a_proposta(self) -> None:  # #274
        found = self.lines([divergence("E3", ["S1"], "Contado 1.2.3 UN de 4 UN: Arroz 5kg")])
        self.assertEqual(found, [{"sku": "S1", "quantity": {"amount": 10, "unit": "UN"}, "disposition": "devolver"}])

    def test_as_outras_excecoes_seguram_o_item_inteiro_na_unidade_dele(self) -> None:  # ADR-002
        for code in ("E1", "E2", "E4"):
            found = self.lines([divergence(code, ["S1", "S2"])])
            self.assertEqual(found, [
                {"sku": "S1", "quantity": {"amount": 10, "unit": "UN"}, "disposition": "segurar"},
                {"sku": "S2", "quantity": {"amount": 5, "unit": "CX"}, "disposition": "segurar"},
            ], code)

    def test_item_fora_das_divergencias_nao_entra_e_sem_divergencia_a_lista_e_vazia(self) -> None:  # ADR-002
        self.assertEqual([line["sku"] for line in self.lines([divergence("E4", ["S1"])])], ["S1"])
        self.assertEqual(self.lines([]), [])

    def test_o_primeiro_motivo_de_um_sku_vale_e_o_item_sem_sku_usa_o_codigo_do_fornecedor(self) -> None:  # ADR-002
        items = [{"supplierCode": "A1", "sku": None, "description": "Arroz 5kg", "quantity": {"amount": 4, "unit": "UN"}}]
        found = self.lines([divergence("E4", ["A1"]), divergence("E3", ["A1"], "Contado 1 UN de 4 UN: Arroz 5kg")], items)
        self.assertEqual(found, [{"sku": "A1", "quantity": {"amount": 4, "unit": "UN"}, "disposition": "segurar"}])


class DivergenceEvidenceTest(unittest.TestCase):
    def test_a_evidencia_leva_so_os_campos_nomeados(self) -> None:  # ADR-002
        evidence = [{"source": "wms", "reference": "r1", "description": "Contado 7 UN", "interno": "nao-sai"}]
        output = translation.proposal(proposal_body(divergences=[
            {"classification": "E3", "exceptionName": "n", "skus": ["S1"], "evidence": evidence}]))
        self.assertEqual(output["divergences"][0]["evidence"], [{"source": "wms", "reference": "r1", "description": "Contado 7 UN"}])


class EngineSimilarCasesTest(unittest.TestCase):
    def engine(self, **fields: JsonValue) -> JsonObject:
        base = {"outcome": "approve", "similar_cases": [{"x": 1}, {"x": 2}, {"x": 3}], **fields}
        engine = translation.proposal(proposal_body(engine=base))["engine"]
        assert engine is not None
        return engine

    def test_a_contagem_dos_casos_parecidos_vem_da_tool(self) -> None:  # ADR-002
        self.assertEqual(self.engine()["similar_cases_count"], 3)

    def test_sem_a_lista_nao_ha_contagem(self) -> None:  # ADR-002
        self.assertNotIn("similar_cases_count", self.engine(similar_cases=None))


if __name__ == "__main__":
    unittest.main()
