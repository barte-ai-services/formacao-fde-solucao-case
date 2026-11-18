"""Tradução da resposta da API (camelCase) para a saída das tools da #137 (snake_case, dinheiro { cents, text }).

Cada saída monta campos nomeados, um a um: nenhum objeto da API passa inteiro, de modo que um campo novo
da API não chega à pessoa sem alguém decidir isso aqui."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

# America/Sao_Paulo sem horário de verão desde 2019: um deslocamento fixo dispensa o banco de fusos, que o
# Pyodide não traz. Se o horário de verão voltar, este é o ponto a trocar.
SAO_PAULO = timezone(timedelta(hours=-3))
# `Any` neste módulo é o JSON da API, decodificado: o contrato só se confere campo a campo, abaixo.
_MAIUSCULA = re.compile(r"(?<!^)(?=[A-Z])")


def snake(nome: str) -> str:
    return _MAIUSCULA.sub("_", nome).lower()


def snake_chaves(valor: Any) -> Any:
    """As chaves de um campo da API que a #137 repassa como veio (o dossiê e o auditor), em snake_case."""
    if isinstance(valor, dict):
        return {snake(chave): snake_chaves(v) for chave, v in valor.items()}
    if isinstance(valor, list):
        return [snake_chaves(v) for v in valor]
    return valor


def _obter(corpo: Any, campo: str) -> Any:
    return corpo.get(campo) if isinstance(corpo, dict) else None


def _dinheiro(valor: Any) -> Optional[dict[str, Any]]:
    if not isinstance(valor, dict):
        return None
    return {"cents": valor.get("cents"), "text": valor.get("text")}


def hora_em_sao_paulo(instante: Any) -> Optional[str]:
    """Um instante ISO 8601 como 10h12, no horário de Brasília. Nulo se não for um instante."""
    if not isinstance(instante, str):
        return None
    try:
        quando = datetime.fromisoformat(instante.replace("Z", "+00:00"))
    except ValueError:
        return None
    if quando.tzinfo is None:
        quando = quando.replace(tzinfo=timezone.utc)
    local = quando.astimezone(SAO_PAULO)
    return f"{local.hour:02d}h{local.minute:02d}"


def item_da_fila(linha: dict[str, Any]) -> dict[str, Any]:
    """Os campos da linha da fila (#137). O `engine` e o `dossier_status` não vêm em GET /api/fila: ficam
    `null` e `none` até a proposta ser aberta (get_proposal)."""
    return {
        "invoice_access_key": linha.get("invoiceAccessKey"),
        "number": linha.get("number"),
        "supplier_id": linha.get("supplierId"),
        "store": linha.get("store"),
        "total": _dinheiro(linha.get("total")),
        "classification": linha.get("classification"),
        "classification_name": linha.get("exceptionName"),
        "level": linha.get("level"),
        "required_approver_level": linha.get("requiredApproverLevel"),
        "amount_at_risk": _dinheiro(linha.get("amountAtRisk")),
        "dock_action": _acao_na_doca(linha.get("dockAction")),
        "can_decide": linha.get("canApprove") is True,
        "dossier_status": "none",
        "engine": None,
    }


def fila(corpo: Any, escopo: str, classificacoes: Optional[list[str]], niveis: Optional[list[str]]) -> dict[str, Any]:
    """`scope` e os filtros só escolhem linhas da resposta da API; nada é recalculado aqui."""
    aprovador = _obter(corpo, "approver")
    itens = _obter(corpo, "items")
    if not isinstance(aprovador, dict) or not isinstance(itens, list):
        raise ValueError("fila fora do contrato")
    saida = []
    for linha in itens:
        item = item_da_fila(linha)
        if escopo == "mine" and not item["can_decide"]:
            continue
        if classificacoes is not None and item["classification"] not in classificacoes:
            continue
        if niveis is not None and item["level"] not in niveis:
            continue
        saida.append(item)
    return {"approver": {"email": aprovador.get("email"), "level": aprovador.get("level")}, "items": saida}


def _acao_na_doca(acao: Any) -> Optional[dict[str, Any]]:
    if not isinstance(acao, dict):
        return None
    saida = {"kind": acao.get("kind")}
    if isinstance(acao.get("lines"), list):
        saida["lines"] = [
            {"sku": l.get("sku"), "quantity": _quantidade(l.get("quantity")), "disposition": l.get("disposition")}
            for l in acao["lines"]
            if isinstance(l, dict)
        ]
    return saida


def _quantidade(valor: Any) -> Optional[dict[str, Any]]:
    if not isinstance(valor, dict):
        return None
    return {"amount": valor.get("amount"), "unit": valor.get("unit")}


_DECISAO_PELO_ESTADO = {"aprovada": "approve", "alterada": "change"}


def momento_da_decisao(proposta: Any) -> Optional[str]:
    """O instante da decisão na linha do tempo da proposta; sem ele, o dia gravado na aprovação."""
    for evento in _obter(proposta, "timeline") or []:
        if isinstance(evento, dict) and evento.get("kind") == "decisao" and evento.get("at"):
            return evento["at"]
    return _obter(_obter(proposta, "approval"), "decidedOn")


def aprovacao(aprov: Any, decisao: Optional[str], quando: Optional[str]) -> Optional[dict[str, Any]]:
    if not isinstance(aprov, dict):
        return None
    return {
        "approver": aprov.get("approver"),
        "approver_level": aprov.get("approverLevel"),
        "decided_at": quando or aprov.get("decidedOn"),
        "decision": decisao,
        "dock_action": _acao_na_doca(aprov.get("dockAction")),
        "justification": aprov.get("justification"),
    }


def decisao_registrada(corpo: Any, decisao: str) -> dict[str, Any]:
    """A saída de decide_proposal: a aprovação gravada e o estado do título."""
    registrada = aprovacao(_obter(corpo, "approval"), decisao, None)
    titulo = _obter(corpo, "title")
    if registrada is None or not isinstance(titulo, dict):
        raise ValueError("decisão fora do contrato")
    return {"approval": registrada, "title_state": titulo.get("state")}


_CAMPOS_DO_MOTOR = (
    "mode", "outcome", "decided_by", "confidence", "model_version", "reason", "pending_reason", "recommendation",
    "decided_at", "similar_cases", "clef", "person_outcome", "agreement",
)


def _motor(motor: Any) -> Optional[dict[str, Any]]:
    if not isinstance(motor, dict):
        return None
    return {campo: motor.get(campo) for campo in _CAMPOS_DO_MOTOR if campo in motor}


def _item_da_nota(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "supplier_code": item.get("supplierCode"),
        "sku": item.get("sku"),
        "description": item.get("description"),
        "quantity": _quantidade(item.get("quantity")),
        "stock_quantity": _quantidade(item.get("stockQuantity")),
        "unit_price": _dinheiro(item.get("unitPrice")),
        "total": _dinheiro(item.get("total")),
    }


def _divergencia(d: dict[str, Any]) -> dict[str, Any]:
    return {
        "classification": d.get("classification"),
        "classification_name": d.get("exceptionName"),
        "skus": d.get("skus"),
        "evidence": d.get("evidence"),
    }


def proposta(corpo: Any) -> dict[str, Any]:
    """A saída de get_proposal: a linha da fila e o que a #137 acrescenta."""
    if not isinstance(corpo, dict):
        raise ValueError("proposta fora do contrato")
    titulo = corpo.get("title") if isinstance(corpo.get("title"), dict) else {}
    dossie = corpo.get("dossier") if isinstance(corpo.get("dossier"), dict) else None
    estado_do_dossie = dossie.get("status") if dossie else None
    saida = item_da_fila(corpo)
    saida.update(
        {
            "dossier_status": estado_do_dossie if estado_do_dossie in ("ready", "generating", "unavailable") else "none",
            "engine": _motor(corpo.get("engine")),
            "regua": {"line": corpo.get("line"), "reason": corpo.get("reason")},
            "justification": corpo.get("justification"),
            "items": [_item_da_nota(i) for i in corpo.get("items") or [] if isinstance(i, dict)],
            "divergences": [_divergencia(d) for d in corpo.get("divergences") or [] if isinstance(d, dict)],
            "title": {"state": titulo.get("state"), "amount": _dinheiro(titulo.get("amount")), "due_on": titulo.get("dueOn")},
            "approval": aprovacao(
                corpo.get("approval"), _DECISAO_PELO_ESTADO.get(corpo.get("state")), momento_da_decisao(corpo)
            ),
            "dossier": snake_chaves(dossie),
            "audit": snake_chaves(corpo.get("audit")),
        }
    )
    return saida
