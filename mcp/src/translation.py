"""Tradução da resposta da API (camelCase) para a saída das tools da #137 (snake_case, dinheiro { cents, text }).

Cada saída monta campos nomeados, um a um: nenhum objeto da API passa inteiro, de modo que um campo novo
da API não chega à pessoa sem alguém decidir isso aqui."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Optional

from json_types import JsonObject, JsonValue

# #272 America/Sao_Paulo sem horário de verão desde 2019: um deslocamento fixo dispensa o banco de fusos, que o
# #272 Pyodide não traz. Se o horário de verão voltar, este é o ponto a trocar.
SAO_PAULO = timezone(timedelta(hours=-3))
_UPPERCASE = re.compile(r"(?<!^)(?=[A-Z])")
_HAS_TIME = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")


def to_snake(name: str) -> str:
    return _UPPERCASE.sub("_", name).lower()


def snake_keys(value: JsonValue) -> JsonValue:
    """As chaves de um campo da API que a #137 repassa como veio (o dossiê e o auditor), em snake_case."""
    if isinstance(value, dict):
        return {to_snake(key): snake_keys(v) for key, v in value.items()}
    if isinstance(value, list):
        return [snake_keys(v) for v in value]
    return value


def _get(body: JsonValue, field: str) -> JsonValue:
    return body.get(field) if isinstance(body, dict) else None


def _money(value: JsonValue) -> Optional[JsonObject]:
    if not isinstance(value, dict):
        return None
    return {"cents": value.get("cents"), "text": value.get("text")}


def hour_in_sao_paulo(moment: JsonValue) -> Optional[str]:
    """Um instante ISO 8601 como 10h12, no horário de Brasília. Nulo se não for um instante com hora: um valor
    só com a data (#272/AC-5) não diz a que horas foi, e converter a meia-noite daria a hora de outro dia."""
    if not isinstance(moment, str) or not _HAS_TIME.match(moment):
        return None
    try:
        when = datetime.fromisoformat(moment.replace("Z", "+00:00"))
    except ValueError:
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    local = when.astimezone(SAO_PAULO)
    return f"{local.hour:02d}h{local.minute:02d}"


def queue_item(line: JsonObject) -> JsonObject:
    """Os campos da linha da fila (#137)."""
    return {
        "invoice_access_key": line.get("invoiceAccessKey"),
        "number": line.get("number"),
        "supplier_id": line.get("supplierId"),
        "store": line.get("store"),
        "total": _money(line.get("total")),
        "classification": line.get("classification"),
        "classification_name": line.get("exceptionName"),
        "level": line.get("level"),
        "required_approver_level": line.get("requiredApproverLevel"),
        "amount_at_risk": _money(line.get("amountAtRisk")),
        "dock_action": _dock_action(line.get("dockAction")),
        "can_decide": line.get("canApprove") is True,
        # #272 GET /api/fila não traz o dossiê: null é "desconhecido", e o valor real vem em get_proposal.
        "dossier_status": None,
        # #137 null já é "sem avaliação"; o motor também só vem em get_proposal.
        "engine": None,
    }


def queue(
    body: JsonValue, scope: str, classifications: Optional[tuple[str, ...]], levels: Optional[tuple[str, ...]]
) -> JsonObject:
    """`scope` e os filtros só escolhem linhas da resposta da API; nada é recalculado aqui."""
    approver = _get(body, "approver")
    items = _get(body, "items")
    if not isinstance(approver, dict) or not isinstance(items, list):
        raise ValueError("fila fora do contrato")
    output = []
    for line in items:
        item = queue_item(line)
        if scope == "mine" and not item["can_decide"]:
            continue
        if classifications is not None and item["classification"] not in classifications:
            continue
        if levels is not None and item["level"] not in levels:
            continue
        output.append(item)
    return {"approver": {"email": approver.get("email"), "level": approver.get("level")}, "items": output}


def _dock_action(action: JsonValue) -> Optional[JsonObject]:
    if not isinstance(action, dict):
        return None
    output: JsonObject = {"kind": action.get("kind")}
    if isinstance(action.get("lines"), list):
        output["lines"] = [
            {"sku": line.get("sku"), "quantity": _quantity(line.get("quantity")), "disposition": line.get("disposition")}
            for line in action["lines"]
            if isinstance(line, dict)
        ]
    return output


def _quantity(value: JsonValue) -> Optional[JsonObject]:
    if not isinstance(value, dict):
        return None
    return {"amount": value.get("amount"), "unit": value.get("unit")}


_DECISION_BY_STATE = {"aprovada": "approve", "alterada": "change"}  # ADR-002


def decision_moment(proposal_body: JsonValue) -> Optional[str]:
    """O instante da decisão na linha do tempo da proposta; sem ele, o dia gravado na aprovação (só a data)."""
    for event in _get(proposal_body, "timeline") or []:
        if isinstance(event, dict) and event.get("kind") == "decisao" and event.get("at"):  # ADR-002
            return event["at"]
    return _get(_get(proposal_body, "approval"), "decidedOn")


def approval(raw: JsonValue, decision: Optional[str], decided_at: Optional[str]) -> Optional[JsonObject]:
    if not isinstance(raw, dict):
        return None
    return {
        "approver": raw.get("approver"),
        "approver_level": raw.get("approverLevel"),
        "decided_at": decided_at or raw.get("decidedOn"),
        "decision": decision,
        "dock_action": _dock_action(raw.get("dockAction")),
        "justification": raw.get("justification"),
    }


def recorded_decision(body: JsonValue, decision: str) -> JsonObject:
    """A saída de decide_proposal: a aprovação gravada e o estado do título."""
    recorded = approval(_get(body, "approval"), decision, None)
    title = _get(body, "title")
    if recorded is None or not isinstance(title, dict):
        raise ValueError("decisão fora do contrato")
    return {"approval": recorded, "title_state": title.get("state")}


_ENGINE_FIELDS = (
    "mode", "outcome", "decided_by", "confidence", "model_version", "reason", "pending_reason", "recommendation",
    "decided_at", "similar_cases", "clef", "person_outcome", "agreement",
)


def _engine(engine: JsonValue) -> Optional[JsonObject]:
    if not isinstance(engine, dict):
        return None
    return {field: engine.get(field) for field in _ENGINE_FIELDS if field in engine}


def _invoice_item(item: JsonObject) -> JsonObject:
    return {
        "supplier_code": item.get("supplierCode"),
        "sku": item.get("sku"),
        "description": item.get("description"),
        "quantity": _quantity(item.get("quantity")),
        "stock_quantity": _quantity(item.get("stockQuantity")),
        "unit_price": _money(item.get("unitPrice")),
        "total": _money(item.get("total")),
    }


def _divergence(divergence: JsonObject) -> JsonObject:
    return {
        "classification": divergence.get("classification"),
        "classification_name": divergence.get("exceptionName"),
        "skus": divergence.get("skus"),
        "evidence": divergence.get("evidence"),
    }


def proposal(body: JsonValue) -> JsonObject:
    """A saída de get_proposal: a linha da fila e o que a #137 acrescenta."""
    if not isinstance(body, dict):
        raise ValueError("proposta fora do contrato")
    title: JsonObject = body["title"] if isinstance(body.get("title"), dict) else {}
    dossier = body.get("dossier") if isinstance(body.get("dossier"), dict) else None
    dossier_status = dossier.get("status") if dossier else None
    output = queue_item(body)
    output.update(
        {
            "dossier_status": dossier_status if dossier_status in ("ready", "generating", "unavailable") else "none",
            "engine": _engine(body.get("engine")),
            "regua": {"line": body.get("line"), "reason": body.get("reason")},
            "justification": body.get("justification"),
            "items": [_invoice_item(i) for i in body.get("items") or [] if isinstance(i, dict)],
            "divergences": [_divergence(d) for d in body.get("divergences") or [] if isinstance(d, dict)],
            "title": {"state": title.get("state"), "amount": _money(title.get("amount")), "due_on": title.get("dueOn")},
            "approval": approval(body.get("approval"), _DECISION_BY_STATE.get(str(body.get("state"))), decision_moment(body)),
            "dossier": snake_keys(dossier),
            "audit": snake_keys(body.get("audit")),
        }
    )
    return output
