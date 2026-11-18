"""Validação das entradas das tools (#137). Recusa antes de chamar a API o que já se sabe inválido."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Mapping, Optional

from errors import ToolError
from json_types import JsonObject, JsonValue

ACCESS_KEY = re.compile(r"^[0-9]{44}$")
CLASSIFICATIONS = ("E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "NAO_CATALOGADA")
# #137 os níveis, as ações na doca e os destinos são os literais do glossário (docs/domain/glossary.md).
LEVELS = ("analista", "coordenacao", "diretoria", "bloqueio")  # ADR-002
DOCK_ACTIONS = ("receber", "receber_parcial", "recusar")  # ADR-002
UNITS = ("UN", "CX")
DISPOSITIONS = ("segurar", "devolver")  # ADR-002


def _invalid(message: str) -> ToolError:
    return ToolError("invalid_input", message)


def _list_of(args: JsonObject, field: str, allowed: tuple[str, ...]) -> Optional[tuple[str, ...]]:
    value = args.get(field)
    if value is None:
        return None
    if not isinstance(value, list) or not all(isinstance(v, str) and v in allowed for v in value):
        raise _invalid(f"{field} deve ser uma lista com valores de {', '.join(allowed)}.")
    return tuple(value)


@dataclass(frozen=True)
class QueueFilters:
    scope: str
    classifications: Optional[tuple[str, ...]]
    levels: Optional[tuple[str, ...]]


def validate_queue(args: JsonObject) -> QueueFilters:
    scope = args.get("scope", "mine")
    if scope not in ("mine", "all"):
        raise _invalid("scope deve ser mine ou all.")
    return QueueFilters(scope, _list_of(args, "classification", CLASSIFICATIONS), _list_of(args, "level", LEVELS))


def validate_read_key(args: JsonObject) -> str:
    # #272 chave mal formada em list/get é invalid_input; em decide_proposal é invalid_dock_action (decisão da rodada 1).
    key = args.get("invoice_access_key")
    if not isinstance(key, str) or not ACCESS_KEY.match(key):
        raise _invalid("invoice_access_key deve ter 44 dígitos.")
    return key


@dataclass(frozen=True)
class Decision:
    access_key: str
    decision: str  # #272 approve ou change
    dock_action: Optional[Mapping[str, JsonValue]]  # #272 só com change, já no formato da API (kind, lines)
    justification: Optional[str]


def _invalid_dock_action(message: str) -> ToolError:
    return ToolError("invalid_dock_action", message)


def _is_positive_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


def _partial_line(line: object) -> JsonObject:
    if not isinstance(line, dict):
        raise _invalid_dock_action("Cada linha deve ser um objeto com sku, quantity e disposition.")
    quantity = line.get("quantity")
    sku = line.get("sku")
    if not isinstance(sku, str) or not sku.strip():
        raise _invalid_dock_action("Cada linha traz o sku.")
    if not isinstance(quantity, dict) or not _is_positive_number(quantity.get("amount")) or quantity.get("unit") not in UNITS:
        raise _invalid_dock_action("Cada linha traz a quantidade positiva em UN ou CX.")
    if line.get("disposition") not in DISPOSITIONS:
        raise _invalid_dock_action("Cada linha diz se segura ou devolve.")
    return {
        "sku": sku,
        "quantity": {"amount": quantity["amount"], "unit": quantity["unit"]},
        "disposition": line["disposition"],
    }


def validate_dock_action(raw: object) -> JsonObject:
    kind = raw.get("kind") if isinstance(raw, dict) else None
    if kind not in DOCK_ACTIONS:
        raise _invalid_dock_action("dock_action.kind deve ser receber, receber_parcial ou recusar.")
    if kind != "receber_parcial":
        return {"kind": kind}
    lines = raw.get("lines") if isinstance(raw, dict) else None
    if not isinstance(lines, list) or not lines:
        raise _invalid_dock_action("Receber parcial exige as linhas (lines).")
    return {"kind": kind, "lines": [_partial_line(line) for line in lines]}


def validate_decision(args: JsonObject) -> Decision:
    # #272 chave mal formada em decide_proposal é invalid_dock_action, como a #137 define para esta tool.
    key = args.get("invoice_access_key")
    if not isinstance(key, str) or not ACCESS_KEY.match(key):
        raise _invalid_dock_action("invoice_access_key deve ter 44 dígitos.")
    decision = args.get("decision")
    if decision not in ("approve", "change"):
        raise _invalid("decision deve ser approve ou change.")
    evidence = args.get("weighed_evidence")
    if evidence is not None and (not isinstance(evidence, list) or not all(isinstance(e, str) for e in evidence)):
        raise _invalid("weighed_evidence deve ser uma lista de textos.")
    if decision == "approve":
        return Decision(key, decision, None, None)
    justification = args.get("justification")
    if not isinstance(justification, str) or not justification.strip():
        raise ToolError("justification_required", "Para alterar, escreva o porquê.")
    return Decision(key, decision, validate_dock_action(args.get("dock_action")), justification.strip())
