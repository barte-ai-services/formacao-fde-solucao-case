"""O protocolo MCP à mão: JSON-RPC 2.0 por Streamable HTTP sem estado em POST /mcp."""

import json
import unittest
from typing import Optional

import app
from json_types import JsonValue
from protocol import HttpRequest, HttpResponse
from test_support import JWT, FakeApi


def request(body: JsonValue, method: str = "POST", path: str = "/mcp") -> HttpRequest:
    text = body if isinstance(body, str) else json.dumps(body)
    return HttpRequest(method, path, text, JWT)


async def ask(http_request: HttpRequest, api: Optional[FakeApi] = None) -> HttpResponse:
    return await app.handle(http_request, api or FakeApi(), lambda fields: None)


def rpc(method: str, params: JsonValue = None, id: Optional[int] = 1) -> dict[str, JsonValue]:
    message: dict[str, JsonValue] = {"jsonrpc": "2.0", "method": method}
    if id is not None:
        message["id"] = id
    if params is not None:
        message["params"] = params
    return message


class InitializeTest(unittest.IsolatedAsyncioTestCase):
    async def initialize(self, version: str) -> JsonValue:
        response = await ask(request(rpc("initialize", {"protocolVersion": version, "capabilities": {}, "clientInfo": {}})))
        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers["Content-Type"], "application/json")
        return json.loads(response.body or "")["result"]

    async def test_devolve_a_versao_pedida_quando_suportada(self) -> None:  # ADR-002
        self.assertEqual((await self.initialize("2025-06-18"))["protocolVersion"], "2025-06-18")

    async def test_devolve_a_mais_recente_quando_a_pedida_nao_e_suportada(self) -> None:  # ADR-002
        self.assertEqual((await self.initialize("1999-01-01"))["protocolVersion"], "2025-11-25")

    async def test_declara_a_capacidade_de_tools(self) -> None:  # ADR-002
        result = await self.initialize("2025-06-18")
        self.assertIn("tools", result["capabilities"])
        self.assertEqual(result["serverInfo"]["name"], "formacao-fde-solucao-case-mcp")


class NotificationsAndPingTest(unittest.IsolatedAsyncioTestCase):
    async def test_notificacao_responde_202_sem_corpo(self) -> None:  # ADR-002
        for method in ("notifications/initialized", "notifications/qualquer-coisa"):
            response = await ask(request(rpc(method, id=None)))
            self.assertEqual(response.status, 202)
            self.assertIsNone(response.body)

    async def test_ping_responde_objeto_vazio(self) -> None:  # ADR-002
        response = await ask(request(rpc("ping", id=7)))
        self.assertEqual(json.loads(response.body or ""), {"jsonrpc": "2.0", "id": 7, "result": {}})

    async def test_get_no_mcp_e_405(self) -> None:  # ADR-002
        response = await ask(request("", method="GET"))
        self.assertEqual(response.status, 405)
        self.assertEqual(response.headers["Allow"], "POST")

    async def test_outro_caminho_e_404(self) -> None:  # ADR-002
        response = await ask(request(rpc("ping"), path="/outra"))
        self.assertEqual(response.status, 404)


class JsonRpcErrorsTest(unittest.IsolatedAsyncioTestCase):
    async def code(self, body: JsonValue) -> int:
        response = await ask(request(body))
        return int(json.loads(response.body or "")["error"]["code"])

    async def test_json_invalido_e_32700(self) -> None:  # ADR-002
        self.assertEqual(await self.code("{isto nao e json"), -32700)

    async def test_requisicao_invalida_e_32600(self) -> None:  # ADR-002
        self.assertEqual(await self.code([1, 2]), -32600)
        self.assertEqual(await self.code({"jsonrpc": "1.0", "method": "ping", "id": 1}), -32600)
        self.assertEqual(await self.code({"jsonrpc": "2.0", "id": 1}), -32600)
        self.assertEqual(await self.code({"jsonrpc": "2.0", "method": "ping", "id": True}), -32600)

    async def test_metodo_desconhecido_e_32601(self) -> None:  # ADR-002
        self.assertEqual(await self.code(rpc("resources/list")), -32601)

    async def test_parametros_invalidos_sao_32602(self) -> None:  # ADR-002
        self.assertEqual(await self.code(rpc("tools/call", {"arguments": {}})), -32602)
        self.assertEqual(await self.code(rpc("tools/call", {"name": "nao_existe"})), -32602)
        self.assertEqual(await self.code(rpc("tools/call", {"name": "get_proposal", "arguments": []})), -32602)
        self.assertEqual(await self.code(rpc("ping", [1])), -32602)


if __name__ == "__main__":
    unittest.main()
