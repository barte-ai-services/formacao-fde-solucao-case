"""As tools de dados do MCP (#137): list_approval_queue, get_proposal e decide_proposal.

Cada uma chama a rota correspondente da API com o JWT do Access de quem chamou e traduz a resposta. O MCP não
decide nada: a régua, a regra 8 e o estado da proposta ficam na API."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

import entradas
import traducao
from cliente_api import Contexto, RespostaApi
from erros import NIVEIS_ROTULO, ErroDeFerramenta, falha_generica, sessao_expirada

_CODIGO = re.compile(r"^[a-z_]{1,40}$")
_ERROS_DE_NIVEL = ("nivel_insuficiente", "sem_nivel")


@dataclass(frozen=True)
class Ferramenta:
    nome: str
    descricao: str
    esquema_de_entrada: dict[str, Any]
    executar: Callable[[dict, Contexto], Awaitable[dict]]
    exige_sessao: bool = True
    meta: Optional[dict[str, Any]] = None  # o plano 2 põe aqui o `ui.resourceUri` do MCP App


def _codigo_da_api(resposta: RespostaApi) -> Optional[str]:
    """O código curto do erro da API (`error`), só se for um identificador; o texto livre nunca passa."""
    codigo = resposta.corpo.get("error") if isinstance(resposta.corpo, dict) else None
    return codigo if isinstance(codigo, str) and _CODIGO.match(codigo) else None


async def _chamar(contexto: Contexto, operacao: str, metodo: str, caminho: str, corpo: Optional[dict[str, Any]] = None) -> RespostaApi:
    try:
        return await contexto.api.chamar(metodo, caminho, contexto.jwt or "", corpo)
    except Exception as e:  # a classe vai ao log; o texto do erro não sai daqui
        raise falha_generica(contexto.registrar, operacao, exception=type(e).__name__) from None


def _falha(contexto: Contexto, operacao: str, resposta: RespostaApi) -> ErroDeFerramenta:
    """401 e 403 são do Access; 404 é chave inexistente; o resto é falha genérica, com o detalhe só no log."""
    if resposta.status in (401, 403):
        return sessao_expirada()
    if resposta.status == 404:
        return ErroDeFerramenta("not_found", "Não encontrei uma proposta com essa chave.")
    return falha_generica(contexto.registrar, operacao, status=resposta.status, api_error=_codigo_da_api(resposta))


def _traduzir(contexto: Contexto, operacao: str, resposta: RespostaApi, convert: Callable[[Any], dict]) -> dict[str, Any]:
    try:
        return convert(resposta.corpo)
    except (ValueError, TypeError, AttributeError):
        raise falha_generica(contexto.registrar, operacao, status=resposta.status, api_error="fora_do_contrato") from None


async def listar_fila(args: dict[str, Any], contexto: Contexto) -> dict[str, Any]:
    filtros = entradas.validar_fila(args)
    resposta = await _chamar(contexto, "list_approval_queue", "GET", "/api/fila")
    if resposta.status != 200:
        raise _falha(contexto, "list_approval_queue", resposta)
    return _traduzir(
        contexto, "list_approval_queue", resposta,
        lambda corpo: traducao.fila(corpo, filtros.escopo, filtros.classificacoes, filtros.niveis),
    )


async def abrir_proposta(args: dict[str, Any], contexto: Contexto) -> dict[str, Any]:
    chave = entradas.validar_chave_de_leitura(args)
    resposta = await _chamar(contexto, "get_proposal", "GET", f"/api/propostas/{chave}")
    if resposta.status != 200:
        raise _falha(contexto, "get_proposal", resposta)
    return _traduzir(contexto, "get_proposal", resposta, traducao.proposta)


async def _reler(contexto: Contexto, chave: str) -> Optional[dict[str, Any]]:
    """Relê a proposta para nomear o nível exigido ou quem decidiu. Falhar aqui não troca o erro principal."""
    try:
        resposta = await contexto.api.chamar("GET", f"/api/propostas/{chave}", contexto.jwt or "", None)
    except Exception as e:
        contexto.registrar({"operation": "decide_proposal.reread", "exception": type(e).__name__})
        return None
    if resposta.status != 200 or not isinstance(resposta.corpo, dict):
        contexto.registrar({"operation": "decide_proposal.reread", "status": resposta.status})
        return None
    return resposta.corpo


async def _nivel_insuficiente(contexto: Contexto, chave: str) -> ErroDeFerramenta:
    proposta = await _reler(contexto, chave)
    rotulo = NIVEIS_ROTULO.get((proposta or {}).get("requiredApproverLevel"))
    if rotulo is None:
        return ErroDeFerramenta("forbidden_level", "Esta proposta pede um nível que você não tem.")
    return ErroDeFerramenta("forbidden_level", f"Esta proposta pede o nível {rotulo} ou acima.")


async def _ja_decidida(contexto: Contexto, chave: str) -> ErroDeFerramenta:
    proposta = await _reler(contexto, chave)
    aprovacao = traducao.aprovacao((proposta or {}).get("approval"), None, None)
    quem = aprovacao and aprovacao["approver"]
    hora = traducao.hora_em_sao_paulo(traducao.momento_da_decisao(proposta)) if proposta else None
    if not isinstance(quem, str) or not quem:
        return ErroDeFerramenta("already_decided", "Esta proposta já foi decidida.")
    quando = f" às {hora}" if hora else ""
    return ErroDeFerramenta("already_decided", f"Esta proposta já foi decidida por {quem}{quando}.")


async def decidir_proposta(args: dict[str, Any], contexto: Contexto) -> dict[str, Any]:
    pedido = entradas.validar_decisao(args)
    # `weighed_evidence` é aceito e validado, mas a API de hoje não o grava: a base de critérios é a #139, e só
    # lá ele passa a ter para onde ir. Até lá não é enviado (a API não tem o campo).
    base = f"/api/propostas/{pedido.chave}"
    if pedido.decisao == "approve":
        resposta = await _chamar(contexto, "decide_proposal", "POST", f"{base}/aprovar")
    else:
        corpo = {"dockAction": pedido.acao_na_doca, "justification": pedido.justificativa}
        resposta = await _chamar(contexto, "decide_proposal", "POST", f"{base}/alterar", corpo)
    codigo = _codigo_da_api(resposta)
    if resposta.status == 200:
        return _traduzir(contexto, "decide_proposal", resposta, lambda c: traducao.decisao_registrada(c, pedido.decisao))
    if resposta.status == 403 and codigo in _ERROS_DE_NIVEL:
        raise await _nivel_insuficiente(contexto, pedido.chave)
    if resposta.status == 409 and codigo == "ja_decidida":
        raise await _ja_decidida(contexto, pedido.chave)
    if resposta.status in (400, 422):
        raise ErroDeFerramenta("invalid_dock_action", "A ação na doca não é válida para esta proposta.")
    raise _falha(contexto, "decide_proposal", resposta)


def criar_ferramentas() -> list[Ferramenta]:
    return [
        Ferramenta(
            "list_approval_queue",
            "Lista a fila de aprovação de quem está logado: as propostas que esperam uma decisão. Por padrão "
            "(scope mine) só as que a pessoa pode decidir pela regra 8; com scope all, todas. classification e "
            "level filtram. Devolve o aprovador e as linhas da fila; todo valor vem desta tool.",
            {
                "type": "object",
                "properties": {
                    "scope": {"type": "string", "enum": ["mine", "all"], "description": "mine (padrão): só as que a pessoa pode decidir."},
                    "classification": {"type": "array", "items": {"type": "string", "enum": list(entradas.CLASSIFICACOES)}, "description": "Filtra pela exceção."},
                    "level": {"type": "array", "items": {"type": "string", "enum": list(entradas.NIVEIS)}, "description": "Filtra pelo nível."},
                },
                "additionalProperties": False,
            },
            listar_fila,
        ),
        Ferramenta(
            "get_proposal",
            "Abre uma proposta da fila: a linha da fila, a régua, os itens, as divergências com a evidência, o título, "
            "a aprovação (se já houve), o dossiê, o motor e o auditor. Chave inexistente devolve not_found.",
            {
                "type": "object",
                "properties": {"invoice_access_key": {"type": "string", "pattern": "^[0-9]{44}$", "description": "Chave de acesso da nota, 44 dígitos."}},
                "required": ["invoice_access_key"],
                "additionalProperties": False,
            },
            abrir_proposta,
        ),
        Ferramenta(
            "decide_proposal",
            "Registra a decisão da pessoa sobre uma proposta: approve aprova a ação na doca proposta; change troca "
            "a ação e exige dock_action e justification. Só chame quando a pessoa pedir. A API confere o nível "
            "(regra 8): forbidden_level, already_decided, justification_required e invalid_dock_action explicam a recusa.",
            {
                "type": "object",
                "properties": {
                    "invoice_access_key": {"type": "string", "pattern": "^[0-9]{44}$", "description": "Chave de acesso da nota, 44 dígitos."},
                    "decision": {"type": "string", "enum": ["approve", "change"], "description": "Aprovar a ação proposta ou alterá-la."},
                    "dock_action": {
                        "type": "object",
                        "description": "Só com change. Com receber_parcial, lines é obrigatório.",
                        "properties": {
                            "kind": {"type": "string", "enum": list(entradas.ACOES)},
                            "lines": {
                                "type": "array",
                                "items": {
                                    "type": "object",
                                    "properties": {
                                        "sku": {"type": "string"},
                                        "quantity": {
                                            "type": "object",
                                            "properties": {"amount": {"type": "number", "exclusiveMinimum": 0}, "unit": {"type": "string", "enum": list(entradas.UNIDADES)}},
                                            "required": ["amount", "unit"],
                                        },
                                        "disposition": {"type": "string", "enum": list(entradas.DESTINOS)},
                                    },
                                    "required": ["sku", "quantity", "disposition"],
                                },
                            },
                        },
                        "required": ["kind"],
                    },
                    "justification": {"type": "string", "description": "Só com change: por que mudou."},
                    "weighed_evidence": {"type": "array", "items": {"type": "string"}, "description": "As evidências que pesaram (base de critérios, #139)."},
                },
                "required": ["invoice_access_key", "decision"],
                "additionalProperties": False,
            },
            decidir_proposta,
        ),
    ]
