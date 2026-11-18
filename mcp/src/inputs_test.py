"""A validação das entradas das tools (#137): recusa antes de chamar a API o que já se sabe inválido."""

import unittest

from errors import ToolError
from inputs import validate_decision, validate_dock_action, validate_queue, validate_read_key
from test_support import KEY


class ValidateQueueTest(unittest.TestCase):
    def test_o_escopo_padrao_e_mine(self) -> None:  # ADR-002
        filters = validate_queue({})
        self.assertEqual((filters.scope, filters.classifications, filters.levels), ("mine", None, None))

    def test_filtros_validos_viram_tuplas(self) -> None:  # ADR-002
        filters = validate_queue({"scope": "all", "classification": ["E4"], "level": ["analista"]})
        self.assertEqual((filters.classifications, filters.levels), (("E4",), ("analista",)))

    def test_valor_fora_da_lista_e_invalid_input(self) -> None:  # ADR-002
        for args in ({"scope": "x"}, {"classification": ["E9"]}, {"level": "analista"}):
            with self.assertRaises(ToolError) as caught:
                validate_queue(args)
            self.assertEqual(caught.exception.code, "invalid_input")


class ValidateReadKeyTest(unittest.TestCase):
    def test_chave_de_44_digitos_passa(self) -> None:  # ADR-002
        self.assertEqual(validate_read_key({"invoice_access_key": KEY}), KEY)

    def test_chave_mal_formada_e_invalid_input_na_leitura(self) -> None:  # ADR-002
        """#272/AC-4"""
        for key in ("123", None, 123, KEY + "0"):
            with self.assertRaises(ToolError) as caught:
                validate_read_key({"invoice_access_key": key})
            self.assertEqual(caught.exception.code, "invalid_input")


class ValidateDockActionTest(unittest.TestCase):
    def test_receber_e_recusar_nao_levam_linhas(self) -> None:  # ADR-002
        self.assertEqual(validate_dock_action({"kind": "recusar", "lines": [1]}), {"kind": "recusar"})

    def test_receber_parcial_copia_so_os_campos_conhecidos(self) -> None:  # ADR-002
        line = {"sku": "S", "quantity": {"amount": 2, "unit": "CX", "x": 1}, "disposition": "segurar", "extra": 1}
        self.assertEqual(
            validate_dock_action({"kind": "receber_parcial", "lines": [line]}),
            {"kind": "receber_parcial", "lines": [{"sku": "S", "quantity": {"amount": 2, "unit": "CX"}, "disposition": "segurar"}]},
        )

    def test_quantidade_zero_ou_booleana_e_recusada(self) -> None:  # ADR-002
        for amount in (0, -1, True):
            line = {"sku": "S", "quantity": {"amount": amount, "unit": "UN"}, "disposition": "segurar"}
            with self.assertRaises(ToolError) as caught:
                validate_dock_action({"kind": "receber_parcial", "lines": [line]})
            self.assertEqual(caught.exception.code, "invalid_dock_action")


class ValidateDecisionTest(unittest.TestCase):
    def test_approve_nao_leva_acao_nem_justificativa(self) -> None:  # ADR-002
        decision = validate_decision({"invoice_access_key": KEY, "decision": "approve", "justification": "x"})
        self.assertEqual((decision.decision, decision.dock_action, decision.justification), ("approve", None, None))

    def test_change_leva_a_acao_e_a_justificativa_sem_espacos(self) -> None:  # ADR-002
        decision = validate_decision(
            {"invoice_access_key": KEY, "decision": "change", "dock_action": {"kind": "recusar"}, "justification": " por quê "}
        )
        self.assertEqual((decision.dock_action, decision.justification), ({"kind": "recusar"}, "por quê"))

    def test_chave_mal_formada_na_decisao_e_invalid_dock_action(self) -> None:  # ADR-002
        """#272/AC-5"""
        with self.assertRaises(ToolError) as caught:
            validate_decision({"invoice_access_key": "1", "decision": "approve"})
        self.assertEqual(caught.exception.code, "invalid_dock_action")


if __name__ == "__main__":
    unittest.main()
