"""A porta do MCP para a API do Worker da fila de aprovação.

O MCP não decide nada: toda leitura e toda decisão passam por esta porta, com o JWT do Access de quem
chamou. Os testes usam um dublê que grava as chamadas; o Worker usa o service binding (worker.py)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Mapping, Optional, Protocol

from errors import Log
from json_types import JsonValue


@dataclass(frozen=True)
class ApiRequest:
    method: str
    path: str
    body: Optional[Mapping[str, JsonValue]] = None


@dataclass(frozen=True)
class ApiResponse:
    status: int
    body: JsonValue = None  # o JSON da resposta, ou None quando não era JSON (#272)


class ApiClient(Protocol):
    async def call(self, request: ApiRequest, jwt: str) -> ApiResponse:
        ...


@dataclass(frozen=True)
class Context:
    """O que uma chamada carrega: quem chamou (o JWT do Access, repassado e nunca guardado nem registrado),
    a porta da API e o registro interno."""

    jwt: Optional[str]
    api: ApiClient
    log: Log


def parse_response(status: int, text: str) -> ApiResponse:
    """Lê o corpo como JSON; o que não for JSON vira None, sem guardar o texto."""
    try:
        return ApiResponse(status, json.loads(text))
    except ValueError:
        return ApiResponse(status, None)
