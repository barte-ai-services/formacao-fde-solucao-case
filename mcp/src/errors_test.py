"""Os erros das tools: o texto é sempre nosso e o detalhe da falha vai ao log só como campos nomeados (#137)."""

import unittest

from errors import GENERIC_FAILURE, SESSION_EXPIRED, LEVEL_LABELS, ToolError, generic_failure, session_expired
from json_types import JsonObject


class ToolErrorTest(unittest.TestCase):
    def test_sessao_expirada_tem_o_codigo_e_a_mensagem_da_137(self) -> None:  # ADR-002
        error = session_expired()
        self.assertEqual((error.code, error.message), ("session_expired", SESSION_EXPIRED))

    def test_os_campos_extras_ficam_no_erro(self) -> None:  # ADR-002
        self.assertEqual(ToolError("x", "m", correlation_id="abc").fields, {"correlation_id": "abc"})

    def test_rotulos_dos_niveis_que_a_pessoa_le(self) -> None:  # ADR-002
        self.assertEqual(LEVEL_LABELS["coordenacao"], "Coordenação")


class GenericFailureTest(unittest.TestCase):
    def test_devolve_o_erro_generico_com_correlacao_e_loga_o_detalhe_nomeado(self) -> None:  # ADR-002
        log: list[JsonObject] = []
        error = generic_failure(log.append, "get_proposal", status=500, api_error=None, exception="RuntimeError")
        self.assertEqual((error.code, error.message), ("unavailable", GENERIC_FAILURE))
        self.assertEqual(
            log,
            [{"operation": "get_proposal", "correlation_id": error.fields["correlation_id"], "status": 500, "exception": "RuntimeError"}],
        )


if __name__ == "__main__":
    unittest.main()
