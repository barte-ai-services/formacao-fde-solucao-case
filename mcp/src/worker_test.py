"""O adaptador do Worker, com dublês dos módulos do runtime (`js`, `workers`) que só existem no Pyodide."""

from __future__ import annotations

import asyncio
import importlib
import json
import sys
import types
import unittest
from typing import TYPE_CHECKING
from unittest import mock

from api_client import ApiRequest, ApiResponse, FetchInit
from test_support import JWT, ROUTE_QUEUE

if TYPE_CHECKING:
    from typing_extensions import Unpack  # #272 o `typing.Unpack` só existe a partir do Python 3.11


class FakeJsResponse:
    def __init__(self, status: int, text: str) -> None:
        self.status = status
        self._text = text

    async def text(self) -> str:
        return self._text


class FakeBinding:
    """O service binding `API`: grava o que recebeu e responde com o que lhe deram, ou falha."""

    def __init__(self, status: int = 200, text: str = "{}", error: Exception | None = None) -> None:
        self.calls: list[tuple[str, FetchInit]] = []
        self.status, self.text, self.error = status, text, error

    async def fetch(self, resource: str, /, **options: Unpack[FetchInit]) -> FakeJsResponse:
        """Como o `_FetcherWrapper` do pacote `workers` no runtime: o init entra só por palavra-chave."""
        self.calls.append((resource, options))
        if self.error:
            raise self.error
        return FakeJsResponse(self.status, self.text)


class FakeResponse:
    def __init__(self, body: str, status: int, headers: dict[str, str]) -> None:
        self.body, self.status, self.headers = body, status, headers


def runtime_modules() -> dict[str, types.ModuleType]:
    js = types.ModuleType("js")
    js.AbortSignal = types.SimpleNamespace(timeout=lambda ms: f"abort-after-{ms}ms")  # type: ignore[attr-defined]
    workers = types.ModuleType("workers")
    workers.Response = FakeResponse  # type: ignore[attr-defined]
    workers.WorkerEntrypoint = type("WorkerEntrypoint", (), {})  # type: ignore[attr-defined]
    return {"js": js, "workers": workers}


class WorkerTestCase(unittest.IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        patcher = mock.patch.dict(sys.modules, runtime_modules())
        patcher.start()
        self.addCleanup(patcher.stop)
        sys.modules.pop("worker", None)
        self.worker = importlib.import_module("worker")  # #272 módulo do Worker, importado sob os dublês do runtime
        self.addCleanup(sys.modules.pop, "worker", None)

    async def call_api(self, binding: FakeBinding, request: ApiRequest) -> ApiResponse:
        return await self.worker.BindingApiClient(binding).call(request, JWT)


class BindingApiClientTest(WorkerTestCase):
    async def test_repassa_o_jwt_no_cabecalho_e_le_o_corpo_como_json(self) -> None:  # ADR-002
        binding = FakeBinding(200, '{"ok": true}')
        response = await self.call_api(binding, ApiRequest(*ROUTE_QUEUE))
        url, options = binding.calls[0]
        self.assertTrue(url.endswith(ROUTE_QUEUE[1]))
        self.assertEqual(options["method"], "GET")
        self.assertEqual(options["headers"]["Cf-Access-Jwt-Assertion"], JWT)
        self.assertEqual((response.status, response.body), (200, {"ok": True}))

    async def test_ac6_a_chamada_a_api_tem_prazo(self) -> None:  # ADR-002
        """#272 REL-1: sem prazo, uma API pendurada prende o Worker; o estouro vira a falha do binding."""
        binding = FakeBinding()
        await self.call_api(binding, ApiRequest(*ROUTE_QUEUE))
        self.assertEqual(binding.calls[0][1]["signal"], "abort-after-10000ms")

    async def test_o_corpo_do_pedido_vai_como_json(self) -> None:  # ADR-002
        binding = FakeBinding()
        await self.call_api(binding, ApiRequest("POST", "/x", {"a": 1}))
        options = binding.calls[0][1]
        self.assertEqual(json.loads(options["body"]), {"a": 1})
        self.assertEqual(options["headers"]["Content-Type"], "application/json")


class DefaultFetchTest(WorkerTestCase):
    PING = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"})

    async def fetch(self, headers: dict[str, str], binding: FakeBinding | None = None, **env: str) -> FakeResponse:
        async def text() -> str:
            return self.PING

        request = types.SimpleNamespace(
            method="POST", url="https://mcp.exemplo/mcp", headers=types.SimpleNamespace(get=headers.get), text=text
        )
        entry = self.worker.Default()
        entry.env = types.SimpleNamespace(API=binding or FakeBinding(), **env)
        return await entry.fetch(request)

    async def test_monta_o_pedido_com_o_jwt_e_devolve_a_resposta_do_app(self) -> None:  # ADR-002
        response = await self.fetch({"Cf-Access-Jwt-Assertion": JWT, "Content-Type": "application/json"})
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.body)["result"], {})
        self.assertEqual(response.headers["Content-Type"], "application/json")

    async def test_sem_content_type_json_e_415(self) -> None:  # ADR-002
        response = await self.fetch({"Cf-Access-Jwt-Assertion": JWT, "Content-Type": "text/plain"})
        self.assertEqual(response.status, 415)

    async def test_origin_e_recusado_por_padrao_e_aceito_se_estiver_em_mcp_allowed_origins(self) -> None:  # ADR-002
        headers = {"Content-Type": "application/json", "Origin": "https://claude.ai"}
        self.assertEqual((await self.fetch(headers)).status, 403)
        self.assertEqual((await self.fetch(headers, MCP_ALLOWED_ORIGINS="")).status, 403)
        self.assertEqual((await self.fetch(headers, MCP_ALLOWED_ORIGINS="https://x.exemplo,https://claude.ai")).status, 200)

    async def test_ac6_a_falha_do_binding_vira_unavailable_sem_o_texto_do_erro(self) -> None:  # ADR-002
        """#272/AC-6 e REL-1: o estouro do prazo e a falha de rede chegam à pessoa como o erro genérico."""
        binding = FakeBinding(error=TimeoutError("sem resposta em segredo.interno.exemplo"))
        call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "list_approval_queue", "arguments": {}}}
        self.PING = json.dumps(call)
        response = await self.fetch({"Cf-Access-Jwt-Assertion": JWT, "Content-Type": "application/json"}, binding)
        result = json.loads(response.body)["result"]
        self.assertTrue(result["isError"])
        self.assertEqual(result["structuredContent"]["error"], "unavailable")
        self.assertNotIn("segredo.interno", response.body)


if __name__ == "__main__":
    unittest.main()
