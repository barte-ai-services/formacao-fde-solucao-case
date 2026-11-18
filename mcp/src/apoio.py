"""Apoio dos testes: o dublê da API que grava as chamadas e as respostas de exemplo (camelCase, como a API)."""

from __future__ import annotations

from typing import Any, Optional

from cliente_api import RespostaApi

CHAVE = "35261174055489000148550010000438941174512643"
OUTRA_CHAVE = "35261174055489000148550010000204601174512644"
JWT = "jwt-de-teste-do-access"


class ApiFalsa:
    """Responde por (método, caminho). Grava cada chamada com o JWT que recebeu."""

    def __init__(self, respostas: Optional[dict[Any, Any]] = None) -> None:
        self.respostas = respostas or {}
        self.chamadas: list[dict[str, Any]] = []

    async def chamar(self, metodo: str, caminho: str, jwt: str, corpo: Optional[dict[str, Any]] = None) -> RespostaApi:
        self.chamadas.append({"metodo": metodo, "caminho": caminho, "jwt": jwt, "corpo": corpo})
        resposta = self.respostas.get((metodo, caminho))
        if isinstance(resposta, Exception):
            raise resposta
        return resposta or RespostaApi(404, {"error": "not_found"})


def dinheiro(centavos: int) -> dict[str, Any]:
    reais, cent = divmod(centavos, 100)
    return {"cents": centavos, "text": f"R$ {reais:,}".replace(",", ".") + f",{cent:02d}"}


def linha(
    chave: str = CHAVE, nivel: str = "analista", pode: bool = True, classificacao: str = "E4",
    numero: str = "43894", exigido: Optional[str] = None,
) -> dict[str, Any]:
    return {
        "invoiceAccessKey": chave, "number": numero, "supplierId": "F02", "store": "CD-01", "issuedOn": "2026-11-17",
        "total": dinheiro(141856), "classification": classificacao, "exceptionCode": classificacao,
        "exceptionName": "Unidade de medida", "level": nivel, "line": 5,
        "reason": "E1 a E4 em nota de até R$ 20 mil", "requiredApproverLevel": exigido or nivel,
        "amountAtRisk": dinheiro(141856), "dockAction": {"kind": "receber"}, "state": "aguardando_aprovacao",
        "canApprove": pode,
    }


def fila(*itens: dict[str, Any], email: str = "ana@exemplo.com", nivel: str = "analista") -> RespostaApi:
    return RespostaApi(200, {"approver": {"email": email, "level": nivel}, "items": list(itens)})


def proposta(
    chave: str = CHAVE, nivel: str = "analista", exigido: Optional[str] = None,
    aprovacao: Optional[dict[str, Any]] = None, estado: str = "aguardando_aprovacao", tempo: Optional[str] = None,
) -> dict[str, Any]:
    return linha(chave, nivel, exigido=exigido) | {
        "state": estado,
        "justification": "Fator de caixa fecha a conta",
        "items": [{"supplierCode": "A1", "sku": "SKU-1006", "description": "Água 500 ml",
                   "quantity": {"amount": 72, "unit": "UN"}, "stockQuantity": None,
                   "unitPrice": dinheiro(1970), "total": dinheiro(141856)}],
        "divergences": [{"classification": "E4", "exceptionCode": "E4", "exceptionName": "Unidade de medida",
                         "skus": ["SKU-1006"], "evidence": "Ordem: 6 CX · Nota: 72 UN"}],
        "title": {"state": "aguardando_aprovacao", "amount": dinheiro(141856), "dueOn": "2026-12-10"},
        "approval": aprovacao,
        "dossier": {"status": "unavailable", "reason": "pending", "notice": "Ainda não avaliado", "generatedAt": None},
        "timeline": [{"at": tempo, "kind": "decisao", "step": "Decidida", "actor": "person", "actor_name": "Pessoa"}] if tempo else [],
        "engine": {"mode": "shadow", "outcome": "approve", "decided_by": "clef", "confidence": 0.99,
                   "model_version": "clef-v1", "reason": "O fator de caixa fecha a conta", "pending_reason": None,
                   "recommendation": None, "decided_at": "2026-11-17T12:00:00Z", "clef": None,
                   "person_outcome": None, "agreement": None, "segredo_interno": "nao-sai"},
        "audit": None,
    }


def resposta_proposta(**kw: Any) -> RespostaApi:
    return RespostaApi(200, proposta(**kw))


def aprovacao(quem: str = "fulano@exemplo.com", acao: Optional[dict[str, Any]] = None) -> dict[str, Any]:
    return {"approver": quem, "approverLevel": "coordenacao", "dockAction": acao or {"kind": "receber"},
            "justification": "", "decidedOn": "2026-11-18"}
