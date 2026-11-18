"""O MCP App da fila (#274): a tool open_approval_app e o recurso ui://formacao-fde/approval."""

import json
import unittest
from typing import Optional

import app
from json_types import JsonObject
from protocol import HttpRequest
from test_support import JWT, KEY, FakeApi

URI = "ui://formacao-fde/approval"
MIME = "text/html;profile=mcp-app"


async def rpc(method: str, params: Optional[JsonObject] = None, jwt: Optional[str] = JWT) -> JsonObject:
    message = {"jsonrpc": "2.0", "id": 7, "method": method, "params": params or {}}
    request = HttpRequest("POST", "/mcp", json.dumps(message), jwt, content_type="application/json")
    api = FakeApi()
    response = await app.handle(request, api, lambda fields: None)
    assert api.calls == [], "abrir a tela não chama a API"
    return json.loads(response.body or "")


async def open_app(arguments: JsonObject, jwt: Optional[str] = JWT) -> JsonObject:
    reply = await rpc("tools/call", {"name": "open_approval_app", "arguments": arguments}, jwt)
    return reply["result"]


class OpenApprovalAppTest(unittest.IsolatedAsyncioTestCase):
    async def test_ac1_tools_list_liga_a_tool_ao_recurso_e_a_marca_como_so_leitura(self) -> None:  # ADR-002
        """#274/AC-1"""
        tools = {t["name"]: t for t in (await rpc("tools/list"))["result"]["tools"]}
        tool = tools["open_approval_app"]
        self.assertEqual(tool["_meta"], {"ui": {"resourceUri": URI}})
        self.assertEqual(tool["annotations"], {"readOnlyHint": True})
        properties = tool["inputSchema"]["properties"]
        self.assertEqual(properties["view"]["enum"], ["queue", "proposal", "report"])
        self.assertEqual(properties["invoice_access_key"]["pattern"], "^[0-9]{44}$")
        self.assertNotIn("required", tool["inputSchema"])
        for other in ("list_approval_queue", "get_proposal", "decide_proposal"):
            self.assertNotIn("_meta", tools[other])

    async def test_ac1_sem_argumentos_abre_a_fila_e_o_texto_manda_o_host_sem_apps_para_a_tool_de_dados(self) -> None:  # ADR-002
        """#274/AC-1"""
        result = await open_app({})
        self.assertFalse(result["isError"])
        self.assertEqual(result["structuredContent"], {"view": "queue", "invoice_access_key": None})
        text = result["content"][0]["text"]
        self.assertIn("list_approval_queue", text)
        self.assertLess(len(text), 300)
        self.assertNotIn("{", text)

    async def test_ac1_a_proposta_leva_a_chave_para_a_tela(self) -> None:  # ADR-002
        """#274/AC-1"""
        result = await open_app({"view": "proposal", "invoice_access_key": KEY})
        self.assertEqual(result["structuredContent"], {"view": "proposal", "invoice_access_key": KEY})
        self.assertIn("get_proposal", result["content"][0]["text"])

    async def test_ac1_a_visao_report_e_aceita(self) -> None:  # ADR-002
        """#274/AC-1"""
        result = await open_app({"view": "report"})
        self.assertEqual(result["structuredContent"], {"view": "report", "invoice_access_key": None})

    async def test_ac1_a_chave_so_e_obrigatoria_com_a_proposta_e_e_validada_como_nas_outras_tools(self) -> None:  # ADR-002
        """#274/AC-1"""
        for arguments in ({"view": "proposal"}, {"view": "proposal", "invoice_access_key": "123"}):
            result = await open_app(arguments)
            self.assertTrue(result["isError"], arguments)
            self.assertEqual(result["structuredContent"]["error"], "invalid_input")

    async def test_ac1_a_chave_dada_fora_da_proposta_e_ignorada_e_nao_volta_para_a_tela(self) -> None:  # ADR-002
        """#274/AC-1"""
        result = await open_app({"view": "queue", "invoice_access_key": KEY})
        self.assertEqual(result["structuredContent"], {"view": "queue", "invoice_access_key": None})

    async def test_ac1_visao_desconhecida_e_recusada(self) -> None:  # ADR-002
        """#274/AC-1"""
        result = await open_app({"view": "painel"})
        self.assertEqual(result["structuredContent"]["error"], "invalid_input")

    async def test_ac1_nao_exige_sessao_para_abrir_a_tela_e_quem_mostra_a_sessao_expirada_e_a_propria_tela(self) -> None:  # ADR-002
        """#274/AC-4: sem sessão a tela ainda abre; é ela que mostra "Sessão do Access expirada" ao chamar as tools de dados."""
        result = await open_app({}, jwt=None)
        self.assertFalse(result["isError"])


class ResourcesTest(unittest.IsolatedAsyncioTestCase):
    async def test_ac1_initialize_anuncia_resources(self) -> None:  # ADR-002
        """#274/AC-1"""
        reply = await rpc("initialize", {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {}})
        self.assertIn("resources", reply["result"]["capabilities"])
        self.assertIn("tools", reply["result"]["capabilities"])

    async def test_ac1_resources_list_traz_a_tela_como_mcp_app(self) -> None:  # ADR-002
        """#274/AC-1"""
        resources = (await rpc("resources/list"))["result"]["resources"]
        self.assertEqual([r["uri"] for r in resources], [URI])
        self.assertEqual(resources[0]["mimeType"], MIME)
        self.assertTrue(resources[0]["name"])

    async def test_ac1_resources_read_devolve_o_html_autocontido_com_o_tipo_do_mcp_app(self) -> None:  # ADR-002
        """#274/AC-1"""
        import approval_screen

        reply = await rpc("resources/read", {"uri": URI})
        (content,) = reply["result"]["contents"]
        self.assertEqual(content["uri"], URI)
        self.assertEqual(content["mimeType"], MIME)
        self.assertEqual(content["text"], approval_screen.APPROVAL_HTML)
        self.assertTrue(content["text"].lstrip().lower().startswith("<!doctype html>"))
        # O host abre a tela sem rede: nenhuma origem externa liberada (#274).
        self.assertEqual(content["_meta"]["ui"]["csp"], {"connectDomains": [], "resourceDomains": []})

    async def test_ac1_resources_read_nao_exige_sessao(self) -> None:  # ADR-002
        """#274/AC-1: o HTML é o mesmo para todos e não leva dado; os dados vêm das tools, que exigem a sessão."""
        reply = await rpc("resources/read", {"uri": URI}, jwt=None)
        self.assertIn("contents", reply["result"])

    async def test_ac1_uri_desconhecida_e_recurso_nao_encontrado(self) -> None:  # ADR-002
        """#274/AC-1"""
        reply = await rpc("resources/read", {"uri": "ui://formacao-fde/outra"})
        self.assertEqual(reply["error"]["code"], -32002)
        self.assertNotIn("outra", reply["error"]["message"])

    async def test_ac1_resources_read_sem_uri_e_parametro_invalido(self) -> None:  # ADR-002
        """#274/AC-1"""
        for params in ({}, {"uri": 3}):
            reply = await rpc("resources/read", params)
            self.assertEqual(reply["error"]["code"], -32602)


if __name__ == "__main__":
    unittest.main()
