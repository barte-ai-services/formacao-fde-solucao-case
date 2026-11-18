"""As tools de dados da #137, dirigidas pelo cenário do Apollo contra um dublê da API.

Cada cenário leva o token do critério da #272 que ele cobre."""

import json
import unittest
from typing import Optional

from api_client import ApiResponse
from json_types import JsonObject
from protocol import HttpRequest
import app
from test_support import (
    JWT, KEY, OTHER_KEY, ROUTE_QUEUE, FakeApi, approval_body, money, proposal_response, queue_line, queue_response,
)

SESSION = "Sua sessão expirou. Entre de novo pelo Access."
ROUTE_APPROVE = ("POST", f"/api/propostas/{KEY}/aprovar")
ROUTE_CHANGE = ("POST", f"/api/propostas/{KEY}/alterar")
ROUTE_READ = ("GET", f"/api/propostas/{KEY}")
PARTIAL = {"kind": "receber_parcial", "lines": [{"sku": "SKU-1006", "quantity": {"amount": 12, "unit": "UN"}, "disposition": "devolver"}]}  # ADR-002
APPROVE = {"invoice_access_key": KEY, "decision": "approve"}


class Session:
    """Uma sessão MCP contra um dublê da API: chama as tools com o JWT dado e guarda o registro interno."""

    def __init__(self, api: FakeApi, jwt: Optional[str] = JWT) -> None:
        self.api = api
        self.jwt = jwt
        self.log: list[JsonObject] = []

    async def call(self, name: str, arguments: JsonObject) -> tuple[JsonObject, str]:
        message = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": arguments}}
        response = await app.handle(HttpRequest("POST", "/mcp", json.dumps(message), self.jwt), self.api, self.log.append)
        text = response.body or ""
        return json.loads(text)["result"], text


def error_of(result: JsonObject) -> JsonObject:
    assert result["isError"] is True, result
    return result["structuredContent"]


class ToolsListTest(unittest.IsolatedAsyncioTestCase):
    async def test_ac2_lista_as_tres_tools_com_as_entradas_da_137(self) -> None:  # ADR-002
        """#272/AC-2"""
        message = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        response = await app.handle(HttpRequest("POST", "/mcp", json.dumps(message), JWT), FakeApi(), lambda c: None)
        tools = {t["name"]: t for t in json.loads(response.body or "")["result"]["tools"]}
        self.assertEqual(set(tools), {"list_approval_queue", "get_proposal", "decide_proposal"})
        self.assertEqual(set(tools["list_approval_queue"]["inputSchema"]["properties"]), {"scope", "classification", "level"})
        self.assertEqual(tools["get_proposal"]["inputSchema"]["required"], ["invoice_access_key"])
        decide = tools["decide_proposal"]["inputSchema"]
        self.assertEqual(
            set(decide["properties"]),
            {"invoice_access_key", "decision", "dock_action", "justification", "weighed_evidence"},
        )
        self.assertEqual(decide["required"], ["invoice_access_key", "decision"])
        for tool in tools.values():
            self.assertTrue(tool["description"].strip())


class QueueListingTest(unittest.IsolatedAsyncioTestCase):
    def api(self) -> FakeApi:
        return FakeApi({ROUTE_QUEUE: queue_response(
            queue_line(),
            queue_line(invoiceAccessKey=OTHER_KEY, level="coordenacao", canApprove=False, classification="E5", number="59738"),
        )})

    async def test_ac3_chama_get_fila_com_o_jwt_e_devolve_so_o_que_o_analista_decide(self) -> None:  # ADR-002
        """#272/AC-3 e #272/AC-6"""
        api = self.api()
        result, _ = await Session(api).call("list_approval_queue", {})
        self.assertEqual(api.calls, [{"method": "GET", "path": ROUTE_QUEUE[1], "jwt": JWT, "body": None}])
        output = result["structuredContent"]
        self.assertFalse(result["isError"])
        self.assertEqual(output["approver"], {"email": "ana@exemplo.com", "level": "analista"})
        self.assertEqual([i["invoice_access_key"] for i in output["items"]], [KEY])
        item = output["items"][0]
        self.assertEqual(item["supplier_id"], "F02")
        self.assertEqual(item["classification_name"], "Unidade de medida")
        self.assertEqual(item["required_approver_level"], "analista")
        self.assertEqual(item["amount_at_risk"], money(141856))
        self.assertEqual(item["total"], money(141856))
        self.assertEqual(item["dock_action"], {"kind": "receber"})
        self.assertIs(item["can_decide"], True)
        self.assertNotIn("invoiceAccessKey", item)
        self.assertEqual(json.loads(result["content"][0]["text"]), output)

    async def test_ac3_scope_all_traz_tambem_o_que_nao_decide(self) -> None:  # ADR-002
        """#272/AC-3"""
        result, _ = await Session(self.api()).call("list_approval_queue", {"scope": "all"})
        self.assertEqual([i["can_decide"] for i in result["structuredContent"]["items"]], [True, False])

    async def test_ac3_classification_e_level_filtram_a_resposta(self) -> None:  # ADR-002
        """#272/AC-3"""
        r, _ = await Session(self.api()).call("list_approval_queue", {"scope": "all", "classification": ["E5"]})
        self.assertEqual([i["classification"] for i in r["structuredContent"]["items"]], ["E5"])
        r, _ = await Session(self.api()).call("list_approval_queue", {"scope": "all", "level": ["analista"]})
        self.assertEqual([i["level"] for i in r["structuredContent"]["items"]], ["analista"])

    async def test_ac3_filtro_invalido_e_recusado_sem_chamar_a_api(self) -> None:  # ADR-002
        """#272/AC-3"""
        session = Session(self.api())
        r, _ = await session.call("list_approval_queue", {"scope": "tudo"})
        self.assertEqual(error_of(r)["error"], "invalid_input")
        r, _ = await session.call("list_approval_queue", {"classification": ["E9"]})
        self.assertEqual(error_of(r)["error"], "invalid_input")
        self.assertEqual(session.api.calls, [])


class ProposalReadingTest(unittest.IsolatedAsyncioTestCase):
    async def test_ac4_devolve_os_campos_da_137_em_snake_case(self) -> None:  # ADR-002
        """#272/AC-4"""
        api = FakeApi({ROUTE_READ: proposal_response()})
        result, text = await Session(api).call("get_proposal", {"invoice_access_key": KEY})
        output = result["structuredContent"]
        self.assertEqual(api.calls[0]["jwt"], JWT)
        self.assertEqual(output["regua"], {"line": 5, "reason": "E1 a E4 em nota de até R$ 20 mil"})
        self.assertEqual(output["items"][0]["supplier_code"], "A1")
        self.assertEqual(output["items"][0]["unit_price"], money(1970))
        self.assertEqual(output["divergences"][0]["skus"], ["SKU-1006"])
        self.assertEqual(output["title"], {"state": "aguardando_aprovacao", "amount": money(141856), "due_on": "2026-12-10"})
        self.assertIsNone(output["approval"])
        self.assertEqual(output["dossier"]["status"], "unavailable")
        self.assertEqual(output["dossier_status"], "unavailable")
        self.assertEqual(output["engine"]["outcome"], "approve")
        self.assertEqual(output["engine"]["reason"], "O fator de caixa fecha a conta")
        self.assertIsNone(output["audit"])
        self.assertNotIn("segredo_interno", text)

    async def test_ac4_chave_inexistente_devolve_not_found(self) -> None:  # ADR-002
        """#272/AC-4"""
        api = FakeApi({ROUTE_READ: ApiResponse(404, {"error": "not_found"})})
        result, _ = await Session(api).call("get_proposal", {"invoice_access_key": KEY})
        self.assertEqual(error_of(result)["error"], "not_found")

    async def test_ac4_chave_mal_formada_e_recusada_sem_chamar_a_api(self) -> None:  # ADR-002
        """#272/AC-4"""
        api = FakeApi()
        result, _ = await Session(api).call("get_proposal", {"invoice_access_key": "123"})
        self.assertEqual(error_of(result)["error"], "invalid_input")
        self.assertEqual(api.calls, [])


class DecisionTest(unittest.IsolatedAsyncioTestCase):
    async def decide(self, api: FakeApi, arguments: JsonObject = APPROVE) -> tuple[JsonObject, str]:
        return await Session(api).call("decide_proposal", arguments)

    async def test_ac5_approve_chama_aprovar_e_devolve_a_decisao(self) -> None:  # ADR-002
        """#272/AC-5"""
        recorded = {"approval": approval_body("ana@exemplo.com"), "title": {"state": "na_lista_do_dia", "amount": money(141856)}}
        api = FakeApi({ROUTE_APPROVE: ApiResponse(200, recorded)})
        result, _ = await self.decide(api)
        self.assertEqual([(c["method"], c["path"], c["jwt"]) for c in api.calls], [("POST", ROUTE_APPROVE[1], JWT)])
        output = result["structuredContent"]
        self.assertEqual(output["approval"]["approver"], "ana@exemplo.com")
        self.assertEqual(output["approval"]["decision"], "approve")
        self.assertEqual(output["approval"]["dock_action"], {"kind": "receber"})
        self.assertEqual(output["approval"]["decided_at"], "2026-11-18")
        self.assertEqual(output["title_state"], "na_lista_do_dia")

    async def test_ac5_change_chama_alterar_com_a_acao_e_a_justificativa(self) -> None:  # ADR-002
        """#272/AC-5"""
        recorded = {"approval": approval_body("ana@exemplo.com", PARTIAL), "title": {"state": "na_lista_do_dia", "amount": money(100)}}
        api = FakeApi({ROUTE_CHANGE: ApiResponse(200, recorded)})
        request = {"invoice_access_key": KEY, "decision": "change", "dock_action": PARTIAL,
                   "justification": "  Só 60 UN chegaram  ", "weighed_evidence": ["Fator de caixa"]}
        result, _ = await self.decide(api, request)
        self.assertEqual(api.calls[0]["path"], ROUTE_CHANGE[1])
        self.assertEqual(api.calls[0]["body"], {"dockAction": PARTIAL, "justification": "Só 60 UN chegaram"})
        self.assertEqual(result["structuredContent"]["approval"]["decision"], "change")

    async def test_ac5_403_de_nivel_vira_forbidden_level_com_o_nivel_da_api(self) -> None:  # ADR-002
        """#272/AC-5 (cenário do Apollo: a proposta pede Coordenação)"""
        api = FakeApi({
            ROUTE_APPROVE: ApiResponse(403, {"error": "nivel_insuficiente", "message": "texto interno da api"}),
            ROUTE_READ: proposal_response(level="coordenacao"),
        })
        result, text = await self.decide(api)
        failure = error_of(result)
        self.assertEqual(failure["error"], "forbidden_level")
        self.assertEqual(failure["message"], "Esta proposta pede o nível Coordenação ou acima.")
        self.assertNotIn("texto interno", text)

    async def test_ac5_sem_nivel_tambem_vira_forbidden_level(self) -> None:  # ADR-002
        """#272/AC-5"""
        api = FakeApi({ROUTE_APPROVE: ApiResponse(403, {"error": "sem_nivel"}), ROUTE_READ: proposal_response(level="diretoria")})
        result, _ = await self.decide(api)
        self.assertEqual(error_of(result)["message"], "Esta proposta pede o nível Diretoria ou acima.")

    async def test_ac5_403_que_nao_e_de_nivel_e_do_access(self) -> None:  # ADR-002
        """#272/AC-5 e #272/AC-6"""
        api = FakeApi({ROUTE_APPROVE: ApiResponse(403, {"error": "forbidden"})})
        result, _ = await self.decide(api)
        self.assertEqual(error_of(result)["message"], SESSION)

    async def test_ac5_409_vira_already_decided_nomeando_quem_e_quando(self) -> None:  # ADR-002
        """#272/AC-5 (a hora em America/Sao_Paulo, formato 10h12)"""
        api = FakeApi({
            ROUTE_APPROVE: ApiResponse(409, {"error": "ja_decidida"}),
            ROUTE_READ: proposal_response("2026-11-18T13:12:40.000Z", approval=approval_body(), state="aprovada"),
        })
        result, _ = await self.decide(api)
        failure = error_of(result)
        self.assertEqual(failure["error"], "already_decided")
        self.assertEqual(failure["message"], "Esta proposta já foi decidida por fulano@exemplo.com às 10h12.")

    async def test_ac5_already_decided_sem_conseguir_reler_fica_sem_quem_e_quando(self) -> None:  # ADR-002
        """#272/AC-5"""
        api = FakeApi({ROUTE_APPROVE: ApiResponse(409, {"error": "ja_decidida"}), ROUTE_READ: ApiResponse(500, None)})
        result, _ = await self.decide(api)
        self.assertEqual(error_of(result)["message"], "Esta proposta já foi decidida.")

    async def test_ac5_change_sem_justificativa_nao_chama_a_api(self) -> None:  # ADR-002
        """#272/AC-5"""
        for justification in (None, "", "   "):
            api = FakeApi()
            request = {"invoice_access_key": KEY, "decision": "change", "dock_action": {"kind": "recusar"}}
            if justification is not None:
                request["justification"] = justification
            result, _ = await self.decide(api, request)
            failure = error_of(result)
            self.assertEqual(failure["error"], "justification_required")
            self.assertEqual(failure["message"], "Para alterar, escreva o porquê.")
            self.assertEqual(api.calls, [])

    async def test_ac5_acao_invalida_e_recusada_antes_de_chamar_a_api(self) -> None:  # ADR-002
        """#272/AC-5"""
        invalid_actions = [
            {"kind": "devolver_tudo"},
            {"kind": "receber_parcial"},
            {"kind": "receber_parcial", "lines": []},
            {"kind": "receber_parcial", "lines": [{"sku": "S", "quantity": {"amount": 1, "unit": "KG"}, "disposition": "segurar"}]},
            {"kind": "receber_parcial", "lines": [{"sku": "S", "quantity": {"amount": 1, "unit": "UN"}, "disposition": "jogar_fora"}]},
            {"kind": "receber_parcial", "lines": ["texto"]},
            None,
        ]
        for action in invalid_actions:
            api = FakeApi()
            request: JsonObject = {"invoice_access_key": KEY, "decision": "change", "justification": "porque sim"}
            if action is not None:
                request["dock_action"] = action
            result, _ = await self.decide(api, request)
            self.assertEqual(error_of(result)["error"], "invalid_dock_action", action)
            self.assertEqual(api.calls, [], action)

    async def test_ac5_chave_com_menos_de_44_digitos_e_invalid_dock_action(self) -> None:  # ADR-002
        """#272/AC-5 (decisão da rodada 1, #272: em decide_proposal a chave mal formada é invalid_dock_action)"""
        api = FakeApi()
        result, _ = await self.decide(api, {"invoice_access_key": "123", "decision": "approve"})
        self.assertEqual(error_of(result)["error"], "invalid_dock_action")
        self.assertEqual(api.calls, [])

    async def test_ac5_422_da_api_vira_invalid_dock_action(self) -> None:  # ADR-002
        """#272/AC-5"""
        api = FakeApi({ROUTE_CHANGE: ApiResponse(422, {"error": "alteracao_invalida", "message": "texto interno"})})
        request = {"invoice_access_key": KEY, "decision": "change", "dock_action": {"kind": "recusar"}, "justification": "x"}
        result, text = await self.decide(api, request)
        self.assertEqual(error_of(result)["error"], "invalid_dock_action")
        self.assertNotIn("texto interno", text)

    async def test_ac5_decisao_e_evidencia_invalidas_sao_recusadas(self) -> None:  # ADR-002
        """#272/AC-5"""
        api = FakeApi()
        result, _ = await self.decide(api, {"invoice_access_key": KEY, "decision": "talvez"})
        self.assertEqual(error_of(result)["error"], "invalid_input")
        result, _ = await self.decide(api, {**APPROVE, "weighed_evidence": "texto solto"})
        self.assertEqual(error_of(result)["error"], "invalid_input")
        self.assertEqual(api.calls, [])

    async def test_ac5_404_vira_not_found(self) -> None:  # ADR-002
        """#272/AC-5"""
        api = FakeApi({ROUTE_APPROVE: ApiResponse(404, {"error": "not_found"})})
        result, _ = await self.decide(api)
        self.assertEqual(error_of(result)["error"], "not_found")


class SessionTest(unittest.IsolatedAsyncioTestCase):
    async def run_tool(self, name: str, arguments: JsonObject, api: FakeApi, jwt: Optional[str] = JWT) -> tuple[Session, JsonObject, str]:
        session = Session(api, jwt)
        result, text = await session.call(name, arguments)
        return session, result, text

    async def test_ac6_sem_o_cabecalho_nenhuma_tool_chama_a_api(self) -> None:  # ADR-002
        """#272/AC-6"""
        arguments = {
            "list_approval_queue": {},
            "get_proposal": {"invoice_access_key": KEY},
            "decide_proposal": APPROVE,
        }
        for jwt in (None, "", "   "):
            for name, args in arguments.items():
                session, result, _ = await self.run_tool(name, args, FakeApi(), jwt)
                failure = error_of(result)
                self.assertEqual(failure["error"], "session_expired")
                self.assertEqual(failure["message"], SESSION)
                self.assertEqual(session.api.calls, [], name)

    async def test_ac6_a_api_recusa_com_401_e_a_sessao_expirou(self) -> None:  # ADR-002
        """#272/AC-6"""
        api = FakeApi({ROUTE_QUEUE: ApiResponse(401, {"error": "unauthorized"})})
        _, result, _ = await self.run_tool("list_approval_queue", {}, api)
        self.assertEqual(error_of(result)["message"], SESSION)

    async def test_ac6_o_jwt_nunca_aparece_na_resposta_nem_no_log(self) -> None:  # ADR-002
        """#272/AC-6"""
        session, _, text = await self.run_tool("list_approval_queue", {}, FakeApi({ROUTE_QUEUE: ApiResponse(500, {"error": "boom"})}))
        self.assertNotIn(JWT, text)
        self.assertNotIn(JWT, json.dumps(session.log))
        self.assertTrue(session.log)


class ExposureTest(unittest.IsolatedAsyncioTestCase):
    """Regra de exposição de camadas: o chamador recebe o erro genérico e um identificador; o detalhe vai ao log."""

    SECRET = "SELECT * FROM approvals WHERE senha='hunter2' em db.interno.exemplo"

    async def list_queue(self, response: ApiResponse | Exception) -> tuple[Session, JsonObject, str]:
        session = Session(FakeApi({ROUTE_QUEUE: response}))
        result, text = await session.call("list_approval_queue", {})
        return session, result, text

    async def test_falha_da_api_devolve_erro_generico_com_correlacao_e_loga_campos_nomeados(self) -> None:  # ADR-002
        body = {"error": "db_down", "message": self.SECRET, "stack": self.SECRET}
        session, result, text = await self.list_queue(ApiResponse(500, body))
        failure = error_of(result)
        self.assertEqual(failure["error"], "unavailable")
        self.assertRegex(failure["correlation_id"], r"^[0-9a-f]{12}$")
        self.assertNotIn("hunter2", text)
        self.assertNotIn("db.interno", text)
        entry = session.log[-1]
        self.assertEqual(entry["operation"], "list_approval_queue")
        self.assertEqual(entry["status"], 500)
        self.assertEqual(entry["api_error"], "db_down")
        self.assertEqual(entry["correlation_id"], failure["correlation_id"])
        self.assertNotIn("hunter2", json.dumps(entry))

    async def test_excecao_do_cliente_nao_vaza_o_texto(self) -> None:  # ADR-002
        session, result, text = await self.list_queue(RuntimeError(self.SECRET))
        self.assertEqual(error_of(result)["error"], "unavailable")
        self.assertNotIn("hunter2", text)
        self.assertNotIn("hunter2", json.dumps(session.log))
        self.assertEqual(session.log[-1]["exception"], "RuntimeError")

    async def test_resposta_com_corpo_que_nao_e_json_nao_vaza(self) -> None:  # ADR-002
        _, result, _ = await self.list_queue(ApiResponse(502, None))
        self.assertEqual(error_of(result)["error"], "unavailable")


if __name__ == "__main__":
    unittest.main()
