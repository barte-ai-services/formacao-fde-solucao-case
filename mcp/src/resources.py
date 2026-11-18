"""Os recursos do MCP (`resources/list` e `resources/read`): a tela do MCP App da fila (#274).

Entram na tabela de métodos do servidor (`Server.register_method`), sem mexer no despacho. O HTML é o mesmo para
todos e não leva dado de ninguém: os dados vêm das tools, que exigem a sessão. Por isso nenhum dos dois pede o JWT."""

from __future__ import annotations

from approval_screen import APPROVAL_HTML
from errors import InvalidParams, ResourceNotFound
from json_types import JsonObject
from protocol import MethodCall, Server
from tools import APPROVAL_APP_URI

APP_MIME_TYPE = "text/html;profile=mcp-app"  # a extensão MCP Apps (io.modelcontextprotocol/ui)
_APPROVAL_NAME = "Fila de aprovação"
_APPROVAL_DESCRIPTION = "A tela do analista: a fila de aprovação, a proposta e a decisão."


async def _resources_list(call: MethodCall) -> JsonObject:
    return {
        "resources": [
            {"uri": APPROVAL_APP_URI, "name": _APPROVAL_NAME, "description": _APPROVAL_DESCRIPTION, "mimeType": APP_MIME_TYPE}
        ]
    }


async def _resources_read(call: MethodCall) -> JsonObject:
    uri = call.params.get("uri")
    if not isinstance(uri, str):
        raise InvalidParams("uri é obrigatório")
    if uri != APPROVAL_APP_URI:
        raise ResourceNotFound()
    return {
        "contents": [
            {
                "uri": APPROVAL_APP_URI,
                "mimeType": APP_MIME_TYPE,
                "text": APPROVAL_HTML,
                # Sem rede: a tela não busca nada de fora, então o host não libera nenhuma origem.
                "_meta": {"ui": {"csp": {"connectDomains": [], "resourceDomains": []}, "prefersBorder": False}},
            }
        ]
    }


def register(server: Server) -> None:
    server.register_method("resources/list", _resources_list)
    server.register_method("resources/read", _resources_read)
