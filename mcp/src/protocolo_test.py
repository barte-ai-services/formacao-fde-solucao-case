"""O protocolo MCP à mão: JSON-RPC 2.0 por Streamable HTTP sem estado em POST /mcp."""

import json
import unittest
from typing import Any, Optional

import aplicacao
from apoio import ApiFalsa, JWT
from protocolo import RespostaHttp


async def pedir(
    corpo: Any, api: Optional[ApiFalsa] = None, metodo: str = "POST", caminho: str = "/mcp", jwt: Optional[str] = JWT
) -> RespostaHttp:
    texto = corpo if isinstance(corpo, str) else json.dumps(corpo)
    return await aplicacao.atender(metodo, caminho, jwt, texto, api or ApiFalsa(), lambda campos: None)


def rpc(metodo: str, params: Any = None, id: Optional[int] = 1) -> dict[str, Any]:
    pedido: dict[str, Any] = {"jsonrpc": "2.0", "method": metodo}
    if id is not None:
        pedido["id"] = id
    if params is not None:
        pedido["params"] = params
    return pedido


class InitializeTest(unittest.IsolatedAsyncioTestCase):
    async def test_devolve_a_versao_pedida_quando_suportada(self) -> None:
        r = await pedir(rpc("initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {}}))
        resultado = json.loads(r.corpo)["result"]
        self.assertEqual(r.status, 200)
        self.assertEqual(r.cabecalhos["Content-Type"], "application/json")
        self.assertEqual(resultado["protocolVersion"], "2025-06-18")

    async def test_devolve_a_mais_recente_quando_a_pedida_nao_e_suportada(self) -> None:
        r = await pedir(rpc("initialize", {"protocolVersion": "1999-01-01"}))
        resultado = json.loads(r.corpo)["result"]
        self.assertEqual(resultado["protocolVersion"], "2025-11-25")

    async def test_declara_a_capacidade_de_tools(self) -> None:
        r = await pedir(rpc("initialize", {"protocolVersion": "2025-06-18"}))
        resultado = json.loads(r.corpo)["result"]
        self.assertIn("tools", resultado["capabilities"])
        self.assertEqual(resultado["serverInfo"]["name"], "formacao-fde-solucao-case-mcp")


class NotificacoesEPingTest(unittest.IsolatedAsyncioTestCase):
    async def test_notificacao_responde_202_sem_corpo(self) -> None:
        for metodo in ("notifications/initialized", "notifications/qualquer-coisa"):
            r = await pedir(rpc(metodo, id=None))
            self.assertEqual(r.status, 202)
            self.assertIsNone(r.corpo)

    async def test_ping_responde_objeto_vazio(self) -> None:
        r = await pedir(rpc("ping", id=7))
        self.assertEqual(json.loads(r.corpo), {"jsonrpc": "2.0", "id": 7, "result": {}})

    async def test_get_no_mcp_e_405(self) -> None:
        r = await pedir("", metodo="GET")
        self.assertEqual(r.status, 405)
        self.assertEqual(r.cabecalhos["Allow"], "POST")

    async def test_outro_caminho_e_404(self) -> None:
        r = await pedir(rpc("ping"), caminho="/outra")
        self.assertEqual(r.status, 404)


class ErrosJsonRpcTest(unittest.IsolatedAsyncioTestCase):
    async def codigo(self, corpo: Any) -> int:
        r = await pedir(corpo)
        return int(json.loads(r.corpo or "")["error"]["code"])

    async def test_json_invalido_e_32700(self) -> None:
        self.assertEqual(await self.codigo("{isto nao e json"), -32700)

    async def test_requisicao_invalida_e_32600(self) -> None:
        self.assertEqual(await self.codigo([1, 2]), -32600)
        self.assertEqual(await self.codigo({"jsonrpc": "1.0", "method": "ping", "id": 1}), -32600)
        self.assertEqual(await self.codigo({"jsonrpc": "2.0", "id": 1}), -32600)
        self.assertEqual(await self.codigo({"jsonrpc": "2.0", "method": "ping", "id": True}), -32600)

    async def test_metodo_desconhecido_e_32601(self) -> None:
        self.assertEqual(await self.codigo(rpc("resources/list")), -32601)

    async def test_parametros_invalidos_sao_32602(self) -> None:
        self.assertEqual(await self.codigo(rpc("tools/call", {"arguments": {}})), -32602)
        self.assertEqual(await self.codigo(rpc("tools/call", {"name": "nao_existe"})), -32602)
        self.assertEqual(await self.codigo(rpc("tools/call", {"name": "get_proposal", "arguments": []})), -32602)
        self.assertEqual(await self.codigo(rpc("ping", [1])), -32602)


if __name__ == "__main__":
    unittest.main()
