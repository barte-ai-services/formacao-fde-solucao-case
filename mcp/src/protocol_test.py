"""O protocolo MCP à mão: JSON-RPC 2.0 por Streamable HTTP sem estado em POST /mcp."""

import json
import unittest
from dataclasses import replace
from types import MappingProxyType
from typing import Mapping, Optional

import app
from json_types import JsonValue
from protocol import HttpRequest, HttpResponse, MethodCall, Settings
from test_support import JWT, FakeApi


def request(body: JsonValue, method: str = "POST", path: str = "/mcp") -> HttpRequest:
    text = body if isinstance(body, str) else json.dumps(body)
    return HttpRequest(method, path, text, JWT, content_type="application/json")


async def ask(http_request: HttpRequest, api: Optional[FakeApi] = None, settings: Settings = Settings()) -> HttpResponse:
    return await app.handle(http_request, api or FakeApi(), lambda fields: None, settings)


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

    async def test_so_as_versoes_cujo_transporte_o_endpoint_fala_sem_lote(self) -> None:  # ADR-002
        """#272: 2025-03-26 e 2024-11-05 admitem lote JSON-RPC, que este endpoint não atende."""
        for requested in ("2025-03-26", "2024-11-05"):
            self.assertEqual((await self.initialize(requested))["protocolVersion"], "2025-11-25")
        self.assertEqual((await self.initialize("2025-11-25"))["protocolVersion"], "2025-11-25")

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


class CrossSiteGuardTest(unittest.IsolatedAsyncioTestCase):
    """#272: um POST de outro site (uma página que o navegador da pessoa abriu) não chega às tools."""

    LIST_TOOLS = rpc("tools/list")
    ALLOWED = Settings(allowed_origins=("https://claude.ai",))

    async def ask_with(self, settings: Settings = Settings(), **headers: str) -> HttpResponse:
        return await ask(replace(request(self.LIST_TOOLS), **headers), FakeApi(), settings)  # type: ignore[arg-type]

    async def test_content_type_que_nao_e_json_e_415_sem_chamar_nada(self) -> None:  # ADR-002
        for content_type in ("text/plain", "application/x-www-form-urlencoded", "multipart/form-data", None):
            api = FakeApi()
            response = await ask(replace(request(rpc("tools/call", {"name": "list_approval_queue"})), content_type=content_type), api)
            self.assertEqual(response.status, 415, content_type)
            self.assertEqual(api.calls, [])

    async def test_json_com_charset_e_aceito(self) -> None:  # ADR-002
        for content_type in ("application/json; charset=utf-8", "Application/JSON"):
            self.assertEqual((await self.ask_with(content_type=content_type)).status, 200)

    async def test_origin_presente_e_recusado_com_403_quando_a_lista_esta_vazia(self) -> None:  # ADR-002
        api = FakeApi()
        response = await ask(replace(request(rpc("tools/call", {"name": "list_approval_queue"})), origin="https://outro.site"), api)
        self.assertEqual(response.status, 403)
        self.assertEqual(api.calls, [])

    async def test_origin_fora_da_lista_e_403_e_na_lista_passa(self) -> None:  # ADR-002
        self.assertEqual((await self.ask_with(self.ALLOWED, origin="https://outro.site")).status, 403)
        self.assertEqual((await self.ask_with(self.ALLOWED, origin="null")).status, 403)
        self.assertEqual((await self.ask_with(self.ALLOWED, origin="https://claude.ai")).status, 200)

    async def test_sem_origin_e_o_cliente_de_servidor_e_segue(self) -> None:  # ADR-002
        self.assertEqual((await self.ask_with()).status, 200)

    async def test_a_recusa_nao_carrega_corpo_nem_o_jwt(self) -> None:  # ADR-002
        response = await self.ask_with(origin="https://outro.site")
        self.assertIsNone(response.body)


class MethodParamsTest(unittest.IsolatedAsyncioTestCase):
    async def test_os_parametros_chegam_ao_metodo_somente_leitura(self) -> None:  # ADR-002
        """#272: `MethodCall` é congelado; os parâmetros que ele guarda também não mudam."""
        seen: list[Mapping[str, JsonValue]] = []

        async def capture(call: MethodCall) -> JsonValue:
            seen.append(call.params)
            return {}

        server = app.create_server()
        server.register_method("captura", capture)
        await server.handle(request(rpc("captura", {"a": 1})), FakeApi(), lambda fields: None)
        self.assertEqual(dict(seen[0]), {"a": 1})
        self.assertIsInstance(seen[0], MappingProxyType)


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
