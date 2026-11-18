"""A aplicação: monta o servidor MCP e atende uma requisição HTTP. Python puro, sem o pacote `workers`."""

from __future__ import annotations

import json
from typing import Optional

from api_client import ApiClient
from errors import Log
from json_types import JsonObject
from protocol import HttpRequest, HttpResponse, Server, ServerInfo, Settings
from tools import create_tools

INFO = ServerInfo(
    "formacao-fde-solucao-case-mcp",
    "0.1.0",
    "Fila de aprovação da Já Chegou, para o analista decidir. Todo número vem destas tools, nunca do texto. "
    "Só chame decide_proposal quando a pessoa pedir, e não contorne uma recusa.",
)


def create_server(settings: Settings = Settings()) -> Server:
    return Server(INFO, create_tools(), settings)


def log_to_console(fields: JsonObject) -> None:
    """O registro interno do Worker: só campos nomeados, em uma linha de JSON."""
    print(json.dumps(fields, ensure_ascii=False))


def parse_allowed_origins(raw: Optional[str]) -> tuple[str, ...]:
    """A variável MCP_ALLOWED_ORIGINS: origens separadas por vírgula. Vazia ou ausente, nenhuma é permitida (#272)."""
    return tuple(origin.strip() for origin in (raw or "").split(",") if origin.strip())


async def handle(
    request: HttpRequest, api: ApiClient, log: Log = log_to_console, settings: Settings = Settings()
) -> HttpResponse:
    """`request.jwt` é o cabeçalho Cf-Access-Jwt-Assertion de quem chamou, ou None. Vai à API como veio e não é guardado."""
    return await create_server(settings).handle(request, api, log)
