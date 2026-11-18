"""A porta do MCP para a API do Worker da fila de aprovação.

O MCP não decide nada: toda leitura e toda decisão passam por esta porta, com o JWT do Access de quem
chamou. Os testes usam um dublê que grava as chamadas; o Worker usa o service binding (worker.py)."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Callable, Optional, Protocol


@dataclass(frozen=True)
class RespostaApi:
    status: int
    corpo: Any = None  # o JSON da resposta, ou None quando não era JSON


class ClienteApi(Protocol):
    async def chamar(self, metodo: str, caminho: str, jwt: str, corpo: Optional[dict[str, Any]] = None) -> RespostaApi:
        ...


@dataclass(frozen=True)
class Contexto:
    """O que uma chamada carrega: quem chamou (o JWT do Access, repassado e nunca guardado nem registrado),
    a porta da API e o registro interno."""

    jwt: Optional[str]
    api: ClienteApi
    registrar: Callable[[dict[str, Any]], None]


def parsear_resposta(status: int, texto: str) -> RespostaApi:
    """Lê o corpo como JSON; o que não for JSON vira None, sem guardar o texto."""
    try:
        return RespostaApi(status, json.loads(texto))
    except ValueError:
        return RespostaApi(status, None)
