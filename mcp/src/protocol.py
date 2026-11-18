"""O protocolo MCP à mão: JSON-RPC 2.0 por Streamable HTTP, sem estado, em POST /mcp, respondendo application/json.

O despacho é uma tabela de métodos (`Server.methods`): o plano 2 (#274) acrescenta `resources/list`,
`resources/read` e uma tool com `_meta.ui.resourceUri` (MCP Apps) registrando na tabela, sem reescrever o despacho."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Awaitable, Callable, Mapping, Optional, Sequence

from api_client import ApiClient, Context
from errors import InvalidParams, Log, ToolError, generic_failure, session_expired
from json_types import JsonObject, JsonValue
from tools import Tool

SUPPORTED_VERSIONS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")  # #272 da mais recente para a mais antiga

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603


def _no_headers() -> Mapping[str, str]:
    return MappingProxyType({})


@dataclass(frozen=True)
class HttpRequest:
    method: str
    path: str
    body: str
    jwt: Optional[str] = None  # o cabeçalho Cf-Access-Jwt-Assertion de quem chamou (#272), repassado e nunca guardado


@dataclass(frozen=True)
class HttpResponse:
    status: int
    headers: Mapping[str, str] = field(default_factory=_no_headers)
    body: Optional[str] = None


@dataclass(frozen=True)
class ServerInfo:
    name: str
    version: str
    instructions: str = ""


def _json(status: int, payload: JsonObject) -> HttpResponse:
    return HttpResponse(status, MappingProxyType({"Content-Type": "application/json"}), json.dumps(payload, ensure_ascii=False))


def _rpc_error(id_: JsonValue, code: int, message: str) -> HttpResponse:
    return _json(200, {"jsonrpc": "2.0", "id": id_, "error": {"code": code, "message": message}})


def _is_valid_id(value: JsonValue) -> bool:
    return isinstance(value, str) or (isinstance(value, int) and not isinstance(value, bool))


class Server:
    def __init__(self, info: ServerInfo, tools: Sequence[Tool]) -> None:
        self.info = info
        self.tools = {tool.name: tool for tool in tools}
        self.methods: dict[str, Method] = {
            "initialize": _initialize,
            "ping": _ping,
            "tools/list": _tools_list,
            "tools/call": _tools_call,
        }

    def register_method(self, name: str, method: Method) -> None:
        self.methods[name] = method

    async def handle(self, request: HttpRequest, api: ApiClient, log: Log) -> HttpResponse:
        if request.path.rstrip("/") != "/mcp":
            return HttpResponse(404)
        if request.method != "POST":
            return HttpResponse(405, MappingProxyType({"Allow": "POST"}))
        try:
            message = json.loads(request.body)
        except ValueError:
            return _rpc_error(None, PARSE_ERROR, "JSON inválido")
        return await self._dispatch(message, Context(request.jwt, api, log))

    async def _dispatch(self, message: JsonValue, ctx: Context) -> HttpResponse:
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0":
            return _rpc_error(None, INVALID_REQUEST, "Requisição inválida")
        if "method" not in message and ("result" in message or "error" in message):
            return HttpResponse(202)  # #272 a resposta do cliente a algo nosso: sem estado, nada a fazer
        name = message.get("method")
        if not isinstance(name, str):
            return _rpc_error(None, INVALID_REQUEST, "Requisição inválida")
        if "id" not in message:
            return HttpResponse(202)  # notificação (#272): sem resposta e, sem estado, nada a guardar
        id_ = message["id"]
        if not _is_valid_id(id_):
            return _rpc_error(None, INVALID_REQUEST, "Requisição inválida")
        params = message.get("params", {})
        if not isinstance(params, dict):
            return _rpc_error(id_, INVALID_PARAMS, "Parâmetros inválidos")
        method = self.methods.get(name)
        if method is None:
            return _rpc_error(id_, METHOD_NOT_FOUND, "Método desconhecido")
        try:
            result = await method(MethodCall(self, params, ctx))
        except InvalidParams as e:
            return _rpc_error(id_, INVALID_PARAMS, str(e) or "Parâmetros inválidos")
        except Exception as e:
            generic_failure(ctx.log, f"rpc:{name}", exception=type(e).__name__)
            return _rpc_error(id_, INTERNAL_ERROR, "Erro interno")
        return _json(200, {"jsonrpc": "2.0", "id": id_, "result": result})


@dataclass(frozen=True)
class MethodCall:
    """O que um método do JSON-RPC recebe: o servidor, os parâmetros da mensagem e o contexto da chamada."""

    server: Server
    params: JsonObject
    ctx: Context


Method = Callable[[MethodCall], Awaitable[JsonValue]]


async def _initialize(call: MethodCall) -> JsonObject:
    server, params = call.server, call.params
    requested = params.get("protocolVersion")
    if not isinstance(requested, str):
        raise InvalidParams("protocolVersion é obrigatório")
    version = requested if requested in SUPPORTED_VERSIONS else SUPPORTED_VERSIONS[0]
    result: JsonObject = {
        "protocolVersion": version,
        "capabilities": {"tools": {"listChanged": False}},
        "serverInfo": {"name": server.info.name, "version": server.info.version},
    }
    if server.info.instructions:
        result["instructions"] = server.info.instructions
    return result


async def _ping(call: MethodCall) -> JsonObject:
    return {}


async def _tools_list(call: MethodCall) -> JsonObject:
    listed = []
    for tool in call.server.tools.values():
        entry: JsonObject = {"name": tool.name, "description": tool.description, "inputSchema": dict(tool.input_schema)}
        if tool.meta:
            entry["_meta"] = dict(tool.meta)
        listed.append(entry)
    return {"tools": listed}


async def _tools_call(call: MethodCall) -> JsonObject:
    server, params, ctx = call.server, call.params, call.ctx
    name = params.get("name")
    tool = server.tools.get(name) if isinstance(name, str) else None
    if tool is None:
        raise InvalidParams("Tool desconhecida")
    arguments = params.get("arguments", {})
    if arguments is None:
        arguments = {}
    if not isinstance(arguments, dict):
        raise InvalidParams("arguments deve ser um objeto")
    try:
        if tool.requires_session and not (ctx.jwt or "").strip():
            raise session_expired()
        return _result(await tool.execute(arguments, ctx))
    except ToolError as e:
        return _error_result(e)
    except Exception as e:
        return _error_result(generic_failure(ctx.log, tool.name, exception=type(e).__name__))


def _result(output: JsonObject) -> JsonObject:
    return {"content": [{"type": "text", "text": json.dumps(output, ensure_ascii=False)}], "structuredContent": output, "isError": False}


def _error_result(error: ToolError) -> JsonObject:
    output = {"error": error.code, "message": error.message, **error.fields}
    return {"content": [{"type": "text", "text": json.dumps(output, ensure_ascii=False)}], "structuredContent": output, "isError": True}
