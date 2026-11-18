"""A aplicação: o servidor MCP montado e uma requisição atendida."""

import io
import json
import unittest
from contextlib import redirect_stdout

import app
from protocol import HttpRequest
from test_support import JWT, FakeApi


class HandleTest(unittest.IsolatedAsyncioTestCase):
    async def test_atende_um_ping_pelo_servidor_montado(self) -> None:  # ADR-002
        body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "ping"})
        response = await app.handle(HttpRequest("POST", "/mcp", body, JWT), FakeApi(), lambda fields: None)
        self.assertEqual(json.loads(response.body or ""), {"jsonrpc": "2.0", "id": 1, "result": {}})

    async def test_o_servidor_traz_as_tres_tools_de_dados(self) -> None:  # ADR-002
        self.assertEqual(set(app.create_server().tools), {"list_approval_queue", "get_proposal", "decide_proposal"})


class LogToConsoleTest(unittest.TestCase):
    def test_escreve_uma_linha_de_json_com_os_campos_nomeados(self) -> None:  # ADR-002
        out = io.StringIO()
        with redirect_stdout(out):
            app.log_to_console({"operation": "x", "status": 500})
        self.assertEqual(json.loads(out.getvalue()), {"operation": "x", "status": 500})


if __name__ == "__main__":
    unittest.main()
