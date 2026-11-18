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

    def test_sem_aprovacao_ou_titulo_e_value_error(self) -> None:  # ADR-002
        with self.assertRaises(ValueError):
            self.record({"approval": approval_body()})


if __name__ == "__main__":
    unittest.main()
