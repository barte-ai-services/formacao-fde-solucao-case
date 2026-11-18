"""O adaptador do Worker, com dublês dos módulos do runtime (`js`, `pyodide.ffi`, `workers`) que só existem no Pyodide."""

import asyncio
import importlib
import json
import sys
import types
import unittest
from unittest import mock

from api_client import ApiRequest, ApiResponse
from json_types import JsonObject
from test_support import JWT, ROUTE_QUEUE


class FakeJsResponse:
    def __init__(self, status: int, text: str) -> None:
        self.status = status
        self._text = text

    async def text(self) -> str:
        return self._text


class FakeBinding:
    """O service binding `API`: grava o que recebeu e responde com o que lhe deram, ou falha."""

    def __init__(self, status: int = 200, text: str = "{}", error: Exception | None = None) -> None:
        self.calls: list[tuple[str, JsonObject]] = []
        self.status, self.text, self.error = status, text, error

    async def fetch(self, url: str, options: JsonObject) -> FakeJsResponse:
        self.calls.append((url, options))
        if self.error:
            raise self.error
        return FakeJsResponse(self.status, self.text)


class FakeResponse:
    def __init__(self, body: str, status: int, headers: dict[str, str]) -> None:
        self.body, self.status, self.headers = body, status, headers


def runtime_modules() -> dict[str, types.ModuleType]:
    js = types.ModuleType("js")
    js.Object = types.SimpleNamespace(fromEntries=object())  # type: ignore[attr-defined]
    js.AbortSignal = types.SimpleNamespace(timeout=lambda ms: f"abort-after-{ms}ms")  # type: ignore[attr-defined]
    ffi = types.ModuleType("pyodide.ffi")
    ffi.to_js = lambda value, **kwargs: value  # type: ignore[attr-defined]
    pyodide = types.ModuleType("pyodide")
    workers = types.ModuleType("workers")
    workers.Response = FakeResponse  # type: ignore[attr-defined]
    workers.WorkerEntrypoint = type("WorkerEntrypoint", (), {})  # type: ignore[attr-defined]
    return {"js": js, "pyodide": pyodide, "pyodide.ffi": ffi, "workers": workers}


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
        self.assertEqual(options["headers"]["Cf-Access-Jwt-Assertion"], JWT)
        self.assertEqual((response.status, response.body), (200, {"ok": True}))

    async def test_o_corpo_do_pedido_vai_como_json(self) -> None:  # ADR-002
        binding = FakeBinding()
        await self.call_api(binding, ApiRequest("POST", "/x", {"a": 1}))
        options = binding.calls[0][1]
        self.assertEqual(json.loads(options["body"]), {"a": 1})
        self.assertEqual(options["headers"]["Content-Type"], "application/json")


class DefaultFetchTest(WorkerTestCase):
    async def test_monta_o_pedido_com_o_jwt_e_devolve_a_resposta_do_app(self) -> None:  # ADR-002
        class Headers:
            def get(self, name: str) -> str | None:
                return JWT if name == "Cf-Access-Jwt-Assertion" else None

        async def text() -> str:
            return json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"})

        request = types.SimpleNamespace(method="POST", url="https://mcp.exemplo/mcp", headers=Headers(), text=text)
        entry = self.worker.Default()
        entry.env = types.SimpleNamespace(API=FakeBinding())
        response = await entry.fetch(request)
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(response.body)["result"], {})
        self.assertEqual(response.headers["Content-Type"], "application/json")


if __name__ == "__main__":
    unittest.main()
