"""Apoio dos testes: o dublê da API que grava as chamadas e as respostas de exemplo (camelCase, como a API).

O nome começa com `test_` para ser lido como auxiliar de teste; o `unittest discover` só coleta `*_test.py`."""

from __future__ import annotations

from typing import Optional

from api_client import ApiRequest, ApiResponse
from json_types import JsonObject, JsonValue

KEY = "35261174055489000148550010000438941174512643"
OTHER_KEY = "35261174055489000148550010000204601174512644"
JWT = "jwt-de-teste-do-access"
ROUTE_QUEUE = ("GET", "/api/fila")  # ADR-002


class FakeApi:
    """Responde por (método, caminho). Grava cada chamada com o JWT que recebeu."""

    def __init__(self, responses: Optional[dict[tuple[str, str], ApiResponse | Exception]] = None) -> None:
        self.responses = responses or {}
        self.calls: list[JsonObject] = []

    async def call(self, request: ApiRequest, jwt: str) -> ApiResponse:
        self.calls.append({"method": request.method, "path": request.path, "jwt": jwt, "body": request.body})
        response = self.responses.get((request.method, request.path))
        if isinstance(response, Exception):
            raise response
        return response or ApiResponse(404, {"error": "not_found"})


def money(cents: int) -> JsonObject:
    reais, rest = divmod(cents, 100)
    return {"cents": cents, "text": f"R$ {reais:,}".replace(",", ".") + f",{rest:02d}"}


def queue_line(**fields: JsonValue) -> JsonObject:
    """Uma linha da fila como a API devolve; `fields` troca ou acrescenta campos. O nível exigido segue o nível."""
    line: JsonObject = {
        "invoiceAccessKey": KEY, "number": "43894", "supplierId": "F02", "store": "CD-01", "issuedOn": "2026-11-17",
        "total": money(141856), "classification": "E4", "exceptionCode": "E4",
        "exceptionName": "Unidade de medida", "level": "analista", "line": 5,
        "reason": "E1 a E4 em nota de até R$ 20 mil",
        "amountAtRisk": money(141856), "dockAction": {"kind": "receber"}, "state": "aguardando_aprovacao",
        "canApprove": True,
    }
    line.update(fields)
    line.setdefault("requiredApproverLevel", line["level"])
    return line


def queue_response(*items: JsonObject, email: str = "ana@exemplo.com", level: str = "analista") -> ApiResponse:
    return ApiResponse(200, {"approver": {"email": email, "level": level}, "items": list(items)})


def proposal_body(decided_at: Optional[str] = None, **fields: JsonValue) -> JsonObject:
    """O corpo de GET /api/propostas/:chave. `decided_at` põe o evento `decisao` na linha do tempo."""
    details: JsonObject = {
        "justification": "Fator de caixa fecha a conta",
        "items": [{"supplierCode": "A1", "sku": "SKU-1006", "description": "Água 500 ml",
                   "quantity": {"amount": 72, "unit": "UN"}, "stockQuantity": None,
                   "unitPrice": money(1970), "total": money(141856)}],
        "divergences": [{"classification": "E4", "exceptionCode": "E4", "exceptionName": "Unidade de medida",
                         "skus": ["SKU-1006"], "evidence": "Ordem: 6 CX · Nota: 72 UN"}],
        "title": {"state": "aguardando_aprovacao", "amount": money(141856), "dueOn": "2026-12-10"},
        "approval": None,
        "dossier": {"status": "unavailable", "reason": "pending", "notice": "Ainda não avaliado", "generatedAt": None},
        "timeline": [{"at": decided_at, "kind": "decisao", "step": "Decidida", "actor": "person", "actor_name": "Pessoa"}]
        if decided_at else [],
        "engine": {"mode": "shadow", "outcome": "approve", "decided_by": "clef", "confidence": 0.99,
                   "model_version": "clef-v1", "reason": "O fator de caixa fecha a conta", "pending_reason": None,
                   "recommendation": None, "decided_at": "2026-11-17T12:00:00Z", "clef": None,
                   "person_outcome": None, "agreement": None, "segredo_interno": "nao-sai"},
        "audit": None,
    }
    body = queue_line(**fields)
    for name, value in details.items():
        body.setdefault(name, value)
    return body


def proposal_response(decided_at: Optional[str] = None, **fields: JsonValue) -> ApiResponse:
    return ApiResponse(200, proposal_body(decided_at, **fields))


def approval_body(who: str = "fulano@exemplo.com", action: Optional[JsonObject] = None) -> JsonObject:
    return {"approver": who, "approverLevel": "coordenacao", "dockAction": action or {"kind": "receber"},
            "justification": "", "decidedOn": "2026-11-18"}
