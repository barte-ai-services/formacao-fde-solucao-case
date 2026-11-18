"""Erros de negócio das tools e os textos que a pessoa lê (#137)."""

from __future__ import annotations

import uuid
from typing import Callable, Optional

from json_types import JsonObject

Log = Callable[[JsonObject], None]

SESSION_EXPIRED = "Sua sessão expirou. Entre de novo pelo Access."
GENERIC_FAILURE = "Não foi possível concluir agora. Tente de novo em instantes."

# #137 os níveis de aprovação são os literais do glossário, e o rótulo é o que a pessoa lê.
LEVEL_LABELS = {"analista": "Analista", "coordenacao": "Coordenação", "diretoria": "Diretoria"}  # ADR-002


class ToolError(Exception):
    """Uma recusa que a tool devolve à pessoa, com o código da #137 e a mensagem em português.

    O texto é sempre nosso: nunca carrega a mensagem ou o corpo de uma dependência."""

    def __init__(self, code: str, message: str, **fields: object) -> None:
        super().__init__(code)
        self.code = code
        self.message = message
        self.fields = fields


class InvalidParams(Exception):
    """Parâmetros do JSON-RPC inválidos (-32602): é do protocolo, não da tool."""


class ResourceNotFound(Exception):
    """O recurso pedido não existe (-32002, do MCP): a URI não é uma das que o servidor serve."""


def session_expired() -> ToolError:
    return ToolError("session_expired", SESSION_EXPIRED)


def generic_failure(log: Log, operation: str, **detail: Optional[object]) -> ToolError:
    """O chamador recebe o erro genérico e um identificador de correlação; o detalhe vai ao log só como campos
    nomeados (operação, status, código do erro, classe da exceção), nunca o texto de um erro nem uma resposta."""
    correlation_id = uuid.uuid4().hex[:12]
    fields = {key: value for key, value in detail.items() if value is not None}
    log({"operation": operation, "correlation_id": correlation_id, **fields})
    return ToolError("unavailable", GENERIC_FAILURE, correlation_id=correlation_id)
