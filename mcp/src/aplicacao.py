"""A aplicação: monta o servidor MCP e atende uma requisição HTTP. Python puro, sem o pacote `workers`."""

from __future__ import annotations

import json
from typing import Any, Callable, Optional

from cliente_api import ClienteApi, Contexto
from ferramentas import criar_ferramentas
from protocolo import RespostaHttp, Servidor

NOME = "formacao-fde-solucao-case-mcp"
VERSAO = "0.1.0"
INSTRUCOES = (
    "Fila de aprovação da Já Chegou, para o analista decidir. Todo número vem destas tools, nunca do texto. "
    "Só chame decide_proposal quando a pessoa pedir, e não contorne uma recusa."
)


def criar_servidor() -> Servidor:
    return Servidor(NOME, VERSAO, criar_ferramentas(), INSTRUCOES)


def registrar_no_console(campos: dict[str, Any]) -> None:
    """O registro interno do Worker: só campos nomeados, em uma linha de JSON."""
    print(json.dumps(campos, ensure_ascii=False))


_SERVIDOR = criar_servidor()


async def atender(
    metodo: str,
    caminho: str,
    jwt: Optional[str],
    corpo: str,
    api: ClienteApi,
    registrar: Callable[[dict[str, Any]], None] = registrar_no_console,
) -> RespostaHttp:
    """`jwt` é o cabeçalho Cf-Access-Jwt-Assertion de quem chamou, ou None. Vai à API como veio e não é guardado."""
    return await _SERVIDOR.atender(metodo, caminho, corpo, Contexto(jwt, api, registrar))
