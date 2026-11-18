"""A porta da API: o corpo da resposta lido como JSON, sem guardar o texto que não for."""

import unittest

from api_client import ApiRequest, ApiResponse, parse_response


class ParseResponseTest(unittest.TestCase):
    def parse(self, status: int, text: str) -> ApiResponse:
        return parse_response(status, text)

    def test_json_vira_o_corpo_da_resposta(self) -> None:  # ADR-002
        self.assertEqual(self.parse(200, '{"a": 1}'), ApiResponse(200, {"a": 1}))

    def test_texto_que_nao_e_json_vira_corpo_nulo_sem_guardar_o_texto(self) -> None:  # ADR-002
        response = self.parse(502, "<html>erro interno com senha</html>")
        self.assertEqual(response, ApiResponse(502, None))
        self.assertNotIn("senha", repr(response))

    def test_pedido_sem_corpo_e_o_padrao(self) -> None:  # ADR-002
        self.assertEqual(self.parse(200, "null"), ApiResponse(200, None))
        self.assertIsNone(ApiRequest("GET", "/x").body)


if __name__ == "__main__":
    unittest.main()
