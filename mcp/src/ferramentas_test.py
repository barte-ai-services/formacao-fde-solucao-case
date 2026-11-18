"""As tools de dados da #137, dirigidas pelo cenário do Apollo contra um dublê da API.

Cada cenário leva o token do critério da #272 que ele cobre."""

import json
import unittest
from typing import Any, Optional

import aplicacao
from apoio import CHAVE, JWT, OUTRA_CHAVE, ApiFalsa, aprovacao, dinheiro, fila, linha, resposta_proposta
from cliente_api import RespostaApi

SESSAO = "Sua sessão expirou. Entre de novo pelo Access."


async def chamar(
    nome: str, argumentos: dict[str, Any], api: ApiFalsa, jwt: Optional[str] = JWT, registros: Optional[list[dict[str, Any]]] = None
) -> tuple[dict[str, Any], str]:
    pedido = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": nome, "arguments": argumentos}}
    registrar = registros.append if registros is not None else (lambda campos: None)
    resposta = await aplicacao.atender("POST", "/mcp", jwt, json.dumps(pedido), api, registrar)
    corpo = resposta.corpo or ""
    return json.loads(corpo)["result"], corpo


def erro(resultado: dict[str, Any]) -> dict[str, Any]:
    assert resultado["isError"] is True, resultado
    return resultado["structuredContent"]


class ToolsListTest(unittest.IsolatedAsyncioTestCase):
    async def test_ac2_lista_as_tres_tools_com_as_entradas_da_137(self) -> None:
        """#272/AC-2"""
        pedido = {"jsonrpc": "2.0", "id": 1, "method": "tools/list"}
        r = await aplicacao.atender("POST", "/mcp", JWT, json.dumps(pedido), ApiFalsa(), lambda c: None)
        tools = {t["name"]: t for t in json.loads(r.corpo or "")["result"]["tools"]}
        self.assertEqual(set(tools), {"list_approval_queue", "get_proposal", "decide_proposal"})
        self.assertEqual(set(tools["list_approval_queue"]["inputSchema"]["properties"]), {"scope", "classification", "level"})
        self.assertEqual(tools["get_proposal"]["inputSchema"]["required"], ["invoice_access_key"])
        decidir = tools["decide_proposal"]["inputSchema"]
        self.assertEqual(
            set(decidir["properties"]),
            {"invoice_access_key", "decision", "dock_action", "justification", "weighed_evidence"},
        )
        self.assertEqual(decidir["required"], ["invoice_access_key", "decision"])
        for tool in tools.values():
            self.assertTrue(tool["description"].strip())


class ListarFilaTest(unittest.IsolatedAsyncioTestCase):
    def api(self) -> ApiFalsa:
        return ApiFalsa({("GET", "/api/fila"): fila(
            linha(CHAVE, "analista", True),
            linha(OUTRA_CHAVE, "coordenacao", False, classificacao="E5", numero="59738"),
        )})

    async def test_ac3_chama_get_fila_com_o_jwt_e_devolve_so_o_que_o_analista_decide(self) -> None:
        """#272/AC-3 e #272/AC-6"""
        api = self.api()
        resultado, _ = await chamar("list_approval_queue", {}, api)
        self.assertEqual(api.chamadas, [{"metodo": "GET", "caminho": "/api/fila", "jwt": JWT, "corpo": None}])
        saida = resultado["structuredContent"]
        self.assertFalse(resultado["isError"])
        self.assertEqual(saida["approver"], {"email": "ana@exemplo.com", "level": "analista"})
        self.assertEqual([i["invoice_access_key"] for i in saida["items"]], [CHAVE])
        item = saida["items"][0]
        self.assertEqual(item["supplier_id"], "F02")
        self.assertEqual(item["classification_name"], "Unidade de medida")
        self.assertEqual(item["required_approver_level"], "analista")
        self.assertEqual(item["amount_at_risk"], dinheiro(141856))
        self.assertEqual(item["total"], dinheiro(141856))
        self.assertEqual(item["dock_action"], {"kind": "receber"})
        self.assertIs(item["can_decide"], True)
        self.assertNotIn("invoiceAccessKey", item)
        self.assertEqual(json.loads(resultado["content"][0]["text"]), saida)

    async def test_ac3_scope_all_traz_tambem_o_que_nao_decide(self) -> None:
        """#272/AC-3"""
        resultado, _ = await chamar("list_approval_queue", {"scope": "all"}, self.api())
        itens = resultado["structuredContent"]["items"]
        self.assertEqual([i["can_decide"] for i in itens], [True, False])

    async def test_ac3_classification_e_level_filtram_a_resposta(self) -> None:
        """#272/AC-3"""
        r, _ = await chamar("list_approval_queue", {"scope": "all", "classification": ["E5"]}, self.api())
        self.assertEqual([i["classification"] for i in r["structuredContent"]["items"]], ["E5"])
        r, _ = await chamar("list_approval_queue", {"scope": "all", "level": ["analista"]}, self.api())
        self.assertEqual([i["level"] for i in r["structuredContent"]["items"]], ["analista"])

    async def test_ac3_filtro_invalido_e_recusado_sem_chamar_a_api(self) -> None:
        """#272/AC-3"""
        api = self.api()
        r, _ = await chamar("list_approval_queue", {"scope": "tudo"}, api)
        self.assertEqual(erro(r)["error"], "invalid_input")
        r, _ = await chamar("list_approval_queue", {"classification": ["E9"]}, api)
        self.assertEqual(erro(r)["error"], "invalid_input")
        self.assertEqual(api.chamadas, [])


class AbrirPropostaTest(unittest.IsolatedAsyncioTestCase):
    async def test_ac4_devolve_os_campos_da_137_em_snake_case(self) -> None:
        """#272/AC-4"""
        api = ApiFalsa({("GET", f"/api/propostas/{CHAVE}"): resposta_proposta()})
        resultado, texto = await chamar("get_proposal", {"invoice_access_key": CHAVE}, api)
        saida = resultado["structuredContent"]
        self.assertEqual(api.chamadas[0]["jwt"], JWT)
        self.assertEqual(saida["regua"], {"line": 5, "reason": "E1 a E4 em nota de até R$ 20 mil"})
        self.assertEqual(saida["items"][0]["supplier_code"], "A1")
        self.assertEqual(saida["items"][0]["unit_price"], dinheiro(1970))
        self.assertEqual(saida["divergences"][0]["skus"], ["SKU-1006"])
        self.assertEqual(saida["title"], {"state": "aguardando_aprovacao", "amount": dinheiro(141856), "due_on": "2026-12-10"})
        self.assertIsNone(saida["approval"])
        self.assertEqual(saida["dossier"]["status"], "unavailable")
        self.assertEqual(saida["dossier_status"], "unavailable")
        self.assertEqual(saida["engine"]["outcome"], "approve")
        self.assertEqual(saida["engine"]["reason"], "O fator de caixa fecha a conta")
        self.assertIsNone(saida["audit"])
        self.assertNotIn("segredo_interno", texto)

    async def test_ac4_chave_inexistente_devolve_not_found(self) -> None:
        """#272/AC-4"""
        api = ApiFalsa({("GET", f"/api/propostas/{CHAVE}"): RespostaApi(404, {"error": "not_found"})})
        resultado, _ = await chamar("get_proposal", {"invoice_access_key": CHAVE}, api)
        self.assertEqual(erro(resultado)["error"], "not_found")

    async def test_ac4_chave_mal_formada_e_recusada_sem_chamar_a_api(self) -> None:
        """#272/AC-4"""
        api = ApiFalsa()
        resultado, _ = await chamar("get_proposal", {"invoice_access_key": "123"}, api)
        self.assertEqual(erro(resultado)["error"], "invalid_input")
        self.assertEqual(api.chamadas, [])


ROTA_APROVAR = ("POST", f"/api/propostas/{CHAVE}/aprovar")
ROTA_ALTERAR = ("POST", f"/api/propostas/{CHAVE}/alterar")
ROTA_LER = ("GET", f"/api/propostas/{CHAVE}")
PARCIAL = {"kind": "receber_parcial", "lines": [{"sku": "SKU-1006", "quantity": {"amount": 12, "unit": "UN"}, "disposition": "devolver"}]}


class DecidirTest(unittest.IsolatedAsyncioTestCase):
    async def test_ac5_approve_chama_aprovar_e_devolve_a_decisao(self) -> None:
        """#272/AC-5"""
        api = ApiFalsa({ROTA_APROVAR: RespostaApi(200, {"approval": aprovacao("ana@exemplo.com"), "title": {"state": "na_lista_do_dia", "amount": dinheiro(141856)}})})
        resultado, _ = await chamar("decide_proposal", {"invoice_access_key": CHAVE, "decision": "approve"}, api)
        self.assertEqual([(c["metodo"], c["caminho"], c["jwt"]) for c in api.chamadas], [("POST", ROTA_APROVAR[1], JWT)])
        saida = resultado["structuredContent"]
        self.assertEqual(saida["approval"]["approver"], "ana@exemplo.com")
        self.assertEqual(saida["approval"]["decision"], "approve")
        self.assertEqual(saida["approval"]["dock_action"], {"kind": "receber"})
        self.assertEqual(saida["approval"]["decided_at"], "2026-11-18")
        self.assertEqual(saida["title_state"], "na_lista_do_dia")

    async def test_ac5_change_chama_alterar_com_a_acao_e_a_justificativa(self) -> None:
        """#272/AC-5"""
        api = ApiFalsa({ROTA_ALTERAR: RespostaApi(200, {"approval": aprovacao("ana@exemplo.com", PARCIAL), "title": {"state": "na_lista_do_dia", "amount": dinheiro(100)}})})
        pedido = {"invoice_access_key": CHAVE, "decision": "change", "dock_action": PARCIAL,
                  "justification": "  Só 60 UN chegaram  ", "weighed_evidence": ["Fator de caixa"]}
        resultado, _ = await chamar("decide_proposal", pedido, api)
        chamada = api.chamadas[0]
        self.assertEqual(chamada["caminho"], ROTA_ALTERAR[1])
        self.assertEqual(chamada["corpo"], {"dockAction": PARCIAL, "justification": "Só 60 UN chegaram"})
        self.assertEqual(resultado["structuredContent"]["approval"]["decision"], "change")

    async def test_ac5_403_de_nivel_vira_forbidden_level_com_o_nivel_da_api(self) -> None:
        """#272/AC-5 (cenário do Apollo: a proposta pede Coordenação)"""
        api = ApiFalsa({
            ROTA_APROVAR: RespostaApi(403, {"error": "nivel_insuficiente", "message": "texto interno da api"}),
            ROTA_LER: resposta_proposta(nivel="coordenacao"),
        })
        resultado, texto = await chamar("decide_proposal", {"invoice_access_key": CHAVE, "decision": "approve"}, api)
        falha = erro(resultado)
        self.assertEqual(falha["error"], "forbidden_level")
        self.assertEqual(falha["message"], "Esta proposta pede o nível Coordenação ou acima.")
        self.assertNotIn("texto interno", texto)

    async def test_ac5_sem_nivel_tambem_vira_forbidden_level(self) -> None:
        """#272/AC-5"""
        api = ApiFalsa({ROTA_APROVAR: RespostaApi(403, {"error": "sem_nivel"}), ROTA_LER: resposta_proposta(nivel="diretoria")})
        resultado, _ = await chamar("decide_proposal", {"invoice_access_key": CHAVE, "decision": "approve"}, api)
        self.assertEqual(erro(resultado)["message"], "Esta proposta pede o nível Diretoria ou acima.")

    async def test_ac5_403_que_nao_e_de_nivel_e_do_access(self) -> None:
        """#272/AC-5 e #272/AC-6"""
        api = ApiFalsa({ROTA_APROVAR: RespostaApi(403, {"error": "forbidden"})})
        resultado, _ = await chamar("decide_proposal", {"invoice_access_key": CHAVE, "decision": "approve"}, api)
        self.assertEqual(erro(resultado)["message"], SESSAO)

    async def test_ac5_409_vira_already_decided_nomeando_quem_e_quando(self) -> None:
        """#272/AC-5 (a hora em America/Sao_Paulo, formato 10h12)"""
        api = ApiFalsa({
            ROTA_APROVAR: RespostaApi(409, {"error": "ja_decidida"}),
            ROTA_LER: resposta_proposta(aprovacao=aprovacao("fulano@exemplo.com"), estado="aprovada", tempo="2026-11-18T13:12:40.000Z"),
        })
        resultado, _ = await chamar("decide_proposal", {"invoice_access_key": CHAVE, "decision": "approve"}, api)
        falha = erro(resultado)
        self.assertEqual(falha["error"], "already_decided")
        self.assertEqual(falha["message"], "Esta proposta já foi decidida por fulano@exemplo.com às 10h12.")

    async def test_ac5_already_decided_sem_conseguir_reler_fica_sem_quem_e_quando(self) -> None:
        """#272/AC-5"""
        api = ApiFalsa({ROTA_APROVAR: RespostaApi(409, {"error": "ja_decidida"}), ROTA_LER: RespostaApi(500, None)})
        resultado, _ = await chamar("decide_proposal", {"invoice_access_key": CHAVE, "decision": "approve"}, api)
        self.assertEqual(erro(resultado)["message"], "Esta proposta já foi decidida.")

    async def test_ac5_change_sem_justificativa_nao_chama_a_api(self) -> None:
        """#272/AC-5"""
        for justificativa in (None, "", "   "):
            api = ApiFalsa()
            pedido = {"invoice_access_key": CHAVE, "decision": "change", "dock_action": {"kind": "recusar"}}
            if justificativa is not None:
                pedido["justification"] = justificativa
            resultado, _ = await chamar("decide_proposal", pedido, api)
            falha = erro(resultado)
            self.assertEqual(falha["error"], "justification_required")
            self.assertEqual(falha["message"], "Para alterar, escreva o porquê.")
            self.assertEqual(api.chamadas, [])

    async def test_ac5_acao_invalida_e_recusada_antes_de_chamar_a_api(self) -> None:
        """#272/AC-5"""
        invalidas = [
            {"kind": "devolver_tudo"},
            {"kind": "receber_parcial"},
            {"kind": "receber_parcial", "lines": []},
            {"kind": "receber_parcial", "lines": [{"sku": "S", "quantity": {"amount": 1, "unit": "KG"}, "disposition": "segurar"}]},
            {"kind": "receber_parcial", "lines": [{"sku": "S", "quantity": {"amount": 1, "unit": "UN"}, "disposition": "jogar_fora"}]},
            {"kind": "receber_parcial", "lines": ["texto"]},
            None,
        ]
        for acao in invalidas:
            api = ApiFalsa()
            pedido = {"invoice_access_key": CHAVE, "decision": "change", "justification": "porque sim"}
            if acao is not None:
                pedido["dock_action"] = acao
            resultado, _ = await chamar("decide_proposal", pedido, api)
            self.assertEqual(erro(resultado)["error"], "invalid_dock_action", acao)
            self.assertEqual(api.chamadas, [], acao)

    async def test_ac5_chave_com_menos_de_44_digitos_e_invalid_dock_action(self) -> None:
        """#272/AC-5"""
        api = ApiFalsa()
        resultado, _ = await chamar("decide_proposal", {"invoice_access_key": "123", "decision": "approve"}, api)
        self.assertEqual(erro(resultado)["error"], "invalid_dock_action")
        self.assertEqual(api.chamadas, [])

    async def test_ac5_422_da_api_vira_invalid_dock_action(self) -> None:
        """#272/AC-5"""
        api = ApiFalsa({ROTA_ALTERAR: RespostaApi(422, {"error": "alteracao_invalida", "message": "texto interno"})})
        pedido = {"invoice_access_key": CHAVE, "decision": "change", "dock_action": {"kind": "recusar"}, "justification": "x"}
        resultado, texto = await chamar("decide_proposal", pedido, api)
        self.assertEqual(erro(resultado)["error"], "invalid_dock_action")
        self.assertNotIn("texto interno", texto)

    async def test_ac5_decisao_e_evidencia_invalidas_sao_recusadas(self) -> None:
        """#272/AC-5"""
        api = ApiFalsa()
        resultado, _ = await chamar("decide_proposal", {"invoice_access_key": CHAVE, "decision": "talvez"}, api)
        self.assertEqual(erro(resultado)["error"], "invalid_input")
        pedido = {"invoice_access_key": CHAVE, "decision": "approve", "weighed_evidence": "texto solto"}
        resultado, _ = await chamar("decide_proposal", pedido, api)
        self.assertEqual(erro(resultado)["error"], "invalid_input")
        self.assertEqual(api.chamadas, [])

    async def test_ac5_404_vira_not_found(self) -> None:
        """#272/AC-5"""
        api = ApiFalsa({ROTA_APROVAR: RespostaApi(404, {"error": "not_found"})})
        resultado, _ = await chamar("decide_proposal", {"invoice_access_key": CHAVE, "decision": "approve"}, api)
        self.assertEqual(erro(resultado)["error"], "not_found")


class SessaoTest(unittest.IsolatedAsyncioTestCase):
    async def test_ac6_sem_o_cabecalho_nenhuma_tool_chama_a_api(self) -> None:
        """#272/AC-6"""
        argumentos = {
            "list_approval_queue": {},
            "get_proposal": {"invoice_access_key": CHAVE},
            "decide_proposal": {"invoice_access_key": CHAVE, "decision": "approve"},
        }
        for jwt in (None, "", "   "):
            for nome, args in argumentos.items():
                api = ApiFalsa()
                resultado, _ = await chamar(nome, args, api, jwt=jwt)
                falha = erro(resultado)
                self.assertEqual(falha["error"], "session_expired")
                self.assertEqual(falha["message"], SESSAO)
                self.assertEqual(api.chamadas, [], nome)

    async def test_ac6_a_api_recusa_com_401_e_a_sessao_expirou(self) -> None:
        """#272/AC-6"""
        api = ApiFalsa({("GET", "/api/fila"): RespostaApi(401, {"error": "unauthorized"})})
        resultado, _ = await chamar("list_approval_queue", {}, api)
        self.assertEqual(erro(resultado)["message"], SESSAO)

    async def test_ac6_o_jwt_nunca_aparece_na_resposta_nem_no_log(self) -> None:
        """#272/AC-6"""
        registros: list[dict[str, Any]] = []
        api = ApiFalsa({("GET", "/api/fila"): RespostaApi(500, {"error": "boom"})})
        _, texto = await chamar("list_approval_queue", {}, api, registros=registros)
        self.assertNotIn(JWT, texto)
        self.assertNotIn(JWT, json.dumps(registros))
        self.assertTrue(registros)


class ExposicaoTest(unittest.IsolatedAsyncioTestCase):
    """Regra de exposição de camadas: o chamador recebe o erro genérico e um identificador; o detalhe vai ao log."""

    SEGREDO = "SELECT * FROM approvals WHERE senha='hunter2' em db.interno.exemplo"

    async def test_falha_da_api_devolve_erro_generico_com_correlacao_e_loga_campos_nomeados(self) -> None:
        registros: list[dict[str, Any]] = []
        api = ApiFalsa({("GET", "/api/fila"): RespostaApi(500, {"error": "db_down", "message": self.SEGREDO, "stack": self.SEGREDO})})
        resultado, texto = await chamar("list_approval_queue", {}, api, registros=registros)
        falha = erro(resultado)
        self.assertEqual(falha["error"], "unavailable")
        self.assertRegex(falha["correlation_id"], r"^[0-9a-f]{12}$")
        self.assertNotIn("hunter2", texto)
        self.assertNotIn("db.interno", texto)
        log = registros[-1]
        self.assertEqual(log["operation"], "list_approval_queue")
        self.assertEqual(log["status"], 500)
        self.assertEqual(log["api_error"], "db_down")
        self.assertEqual(log["correlation_id"], falha["correlation_id"])
        self.assertNotIn("hunter2", json.dumps(log))

    async def test_excecao_do_cliente_nao_vaza_o_texto(self) -> None:
        registros: list[dict[str, Any]] = []
        api = ApiFalsa({("GET", "/api/fila"): RuntimeError(self.SEGREDO)})
        resultado, texto = await chamar("list_approval_queue", {}, api, registros=registros)
        self.assertEqual(erro(resultado)["error"], "unavailable")
        self.assertNotIn("hunter2", texto)
        self.assertNotIn("hunter2", json.dumps(registros))
        self.assertEqual(registros[-1]["exception"], "RuntimeError")

    async def test_resposta_com_corpo_que_nao_e_json_nao_vaza(self) -> None:
        api = ApiFalsa({("GET", "/api/fila"): RespostaApi(502, None)})
        resultado, _ = await chamar("list_approval_queue", {}, api)
        self.assertEqual(erro(resultado)["error"], "unavailable")


if __name__ == "__main__":
    unittest.main()
