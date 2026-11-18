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


def _get(body: JsonValue, field: str) -> JsonValue:
    return body.get(field) if isinstance(body, dict) else None


def _money(value: JsonValue) -> Optional[JsonObject]:
    if not isinstance(value, dict):
        return None
    return {"cents": value.get("cents"), "text": value.get("text")}


def money_text(cents: int) -> str:
    """Centavos como o texto da API (R$ 84.310,20): agrupa os milhares com ponto e separa os centavos com vírgula."""
    reais, rest = divmod(abs(cents), 100)
    sign = "-" if cents < 0 else ""
    return f"{sign}R$ {reais:,}".replace(",", ".") + f",{rest:02d}"


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
    waiting_count = 0
    waiting_cents = 0
    for line in items:
        item = queue_item(line)
        if item["can_decide"]:
            # #274 o cabeçalho "N propostas esperando você · R$ X em risco" é desta tool: a tela não conta nem soma.
            # Vale para toda a fila da pessoa, qualquer que seja o escopo ou o filtro da listagem.
            cents = (item["amount_at_risk"] or {}).get("cents")
            if not isinstance(cents, int) or isinstance(cents, bool):
                raise ValueError("valor em risco fora do contrato")
            waiting_count += 1
            waiting_cents += cents
        if scope == "mine" and not item["can_decide"]:
            continue
        if classifications is not None and item["classification"] not in classifications:
            continue
        if levels is not None and item["level"] not in levels:
            continue
        output.append(item)
    return {
        "approver": {"email": approver.get("email"), "level": approver.get("level")},
        "items": output,
        "waiting_for_you": {"count": waiting_count, "amount_at_risk": {"cents": waiting_cents, "text": money_text(waiting_cents)}},
    }


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
        "decided_hour": hour_in_sao_paulo(decided_at or raw.get("decidedOn")),  # #274 nulo quando só há o dia
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
    "decided_at", "similar_cases", "person_outcome", "agreement",
)


def _clef(clef: JsonValue) -> Optional[JsonObject]:
    """O parecer do Clef (#272): campos nomeados; o que a API acrescentar não passa sem escolha."""
    if not isinstance(clef, dict):
        return None
    return {
        "outcome": clef.get("outcome"),
        "confidence": clef.get("confidence"),
        "model_version": clef.get("model_version"),
        "reason": clef.get("reason"),
        "decided_at": clef.get("decided_at"),
        "agreement": clef.get("agreement"),
    }


def _engine(engine: JsonValue) -> Optional[JsonObject]:
    if not isinstance(engine, dict):
        return None
    output = {field: engine.get(field) for field in _ENGINE_FIELDS if field in engine}
    if isinstance(engine.get("similar_cases"), list):
        output["similar_cases_count"] = len(engine["similar_cases"])  # #274 a tela mostra a contagem, não a conta
    if "clef" in engine:
        output["clef"] = _clef(engine.get("clef"))
    return output


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
        "evidence": _divergence_evidence(divergence.get("evidence")),
    }


def _divergence_evidence(evidence: JsonValue) -> JsonValue:
    """A evidência da divergência (#274): campos nomeados; o que a API acrescentar não passa sem escolha."""
    if not isinstance(evidence, list):
        return evidence
    return [
        {field: item.get(field) for field in ("source", "reference", "description")} if isinstance(item, dict) else item
        for item in evidence
    ]


def _evidence(evidence: JsonValue) -> Optional[list[JsonValue]]:
    if not isinstance(evidence, list):
        return None
    return [
        {field: item.get(field) for field in ("key", "label", "value", "source")}
        for item in evidence
        if isinstance(item, dict)
    ]


def _dossier_divergence(divergence: JsonObject) -> JsonObject:
    return {
        "classification": divergence.get("classification"),
        "classification_name": divergence.get("exceptionName"),
        "what_diverges": divergence.get("whatDiverges"),
        "evidence": _evidence(divergence.get("evidence")),
    }


def _dossier(dossier: JsonValue) -> Optional[JsonObject]:
    """O dossiê (#272/#137): campos nomeados por variante; o que a API acrescentar não passa sem escolha."""
    if not isinstance(dossier, dict):
        return None
    status = dossier.get("status")
    if status == "ready":
        divergences = dossier.get("divergences")
        return {
            "status": status,
            "summary": dossier.get("summary"),
            "divergences": [_dossier_divergence(d) for d in divergences if isinstance(d, dict)]
            if isinstance(divergences, list)
            else None,
            "supplier_history": dossier.get("supplierHistory"),
            "generated_at": dossier.get("generatedAt"),
        }
    if status == "unavailable":
        return {
            "status": status,
            "reason": dossier.get("reason"),
            "notice": dossier.get("notice"),
            "generated_at": dossier.get("generatedAt"),
        }
    if status == "generating":
        return {"status": status, "trigger": dossier.get("trigger"), "requested_at": dossier.get("requestedAt")}
    return {"status": status}


def _agreement(agreement: JsonValue) -> Optional[JsonObject]:
    """A concordância da auditoria (#272)."""
    if not isinstance(agreement, dict):
        return None
    differs = agreement.get("differs")
    return {
        "agrees": agreement.get("agrees"),
        "differs": [d for d in differs if isinstance(d, str)] if isinstance(differs, list) else [],
    }


def _refusal(refusal: JsonObject) -> JsonObject:
    return {
        "refusal": refusal.get("refusal"),
        "field": refusal.get("field"),
        "minimum_level": refusal.get("minimumLevel"),
    }


def _audit(audit: JsonValue) -> Optional[JsonObject]:
    """A auditoria (#272/#137): campos nomeados; o que a API acrescentar não passa sem escolha."""
    if not isinstance(audit, dict):
        return None
    refusals = audit.get("refusals")
    return {
        "status": audit.get("status"),
        "reason": audit.get("reason"),
        "classification": audit.get("classification"),
        "dock_action": _dock_action(audit.get("dockAction")),
        "routing": audit.get("routing"),
        "justification": audit.get("justification"),
        "amount_at_risk": _money(audit.get("amountAtRisk")),
        "audited_at": audit.get("auditedAt"),
        "agreement": _agreement(audit.get("agreement")),
        "raised_level": audit.get("raisedLevel"),
        "injection_flag": audit.get("injectionFlag"),
        "refusals": [_refusal(r) for r in refusals if isinstance(r, dict)] if isinstance(refusals, list) else None,
    }


# #274 Porte de web/src/approval/partial-prefill.ts: só o E3 devolve, e só a diferença; as demais seguram o item inteiro.
_RETURNS = ("E3",)
_COUNTED = re.compile(r"^Contado ([\d.]+) \S+ de ([\d.]+) \S+: (.+)$")


def _number(value: float) -> float | int:
    return int(value) if float(value).is_integer() else value


def _partial_lines(body: JsonObject) -> list[JsonValue]:
    """As linhas que a regra propõe para o receber parcial (#274): o sku, a quantidade e o destino de cada item que
    uma divergência cita. A tela só preenche a tabela com elas; quem decide o número é a tool."""
    items = [i for i in body.get("items") or [] if isinstance(i, dict)]
    lines: dict[str, JsonObject] = {}
    for divergence in body.get("divergences") or []:
        if not isinstance(divergence, dict):
            continue
        code = divergence.get("classification")
        for sku in divergence.get("skus") or []:
            item = next((i for i in items if (i.get("sku") or i.get("supplierCode")) == sku), None)
            quantity = item.get("quantity") if item else None
            if item is None or sku in lines or not isinstance(quantity, dict):
                continue
            amount = quantity.get("amount")
            if code == "E3" and isinstance(amount, (int, float)):
                for evidence in divergence.get("evidence") or []:
                    counted = _COUNTED.match(str(evidence.get("description"))) if isinstance(evidence, dict) else None
                    if counted and counted.group(3) == item.get("description"):
                        # Arredonda: 1,5 - 1,2 não pode virar 0.30000000000000004 no campo.
                        amount = _number(round((float(counted.group(2)) - float(counted.group(1))) * 1000) / 1000)
            lines[sku] = {
                "sku": sku,
                "quantity": {"amount": amount, "unit": quantity.get("unit")},
                "disposition": "devolver" if code in _RETURNS else "segurar",
            }
    return list(lines.values())


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
            "proposed_partial_lines": _partial_lines(body),
            "title": {"state": title.get("state"), "amount": _money(title.get("amount")), "due_on": title.get("dueOn")},
            "approval": approval(body.get("approval"), _DECISION_BY_STATE.get(str(body.get("state"))), decision_moment(body)),
            "dossier": _dossier(dossier),
            "audit": _audit(body.get("audit")),
        }
    )
    return output
