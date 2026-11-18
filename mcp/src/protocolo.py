"""O protocolo MCP à mão: JSON-RPC 2.0 por Streamable HTTP, sem estado, em POST /mcp, respondendo application/json.

O despacho é uma tabela de métodos (`Servidor.metodos`): o plano 2 acrescenta `resources/list`, `resources/read`
e uma tool com `_meta.ui.resourceUri` (MCP Apps) registrando na tabela, sem reescrever o despacho."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from cliente_api import Contexto
from erros import ErroDeFerramenta, ErroDeParametros, falha_generica, sessao_expirada

VERSOES_SUPORTADAS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")  # da mais recente para a mais antiga

PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

# `Any`: o JSON-RPC carrega valores de qualquer forma; cada método confere o que lê.
Metodo = Callable[[dict[str, Any], Contexto], Awaitable[Any]]


@dataclass(frozen=True)
class RespostaHttp:
    status: int
    cabecalhos: dict[str, str] = field(default_factory=dict)
    corpo: Optional[str] = None


def _json(status: int, objeto: dict[str, Any]) -> RespostaHttp:
    return RespostaHttp(status, {"Content-Type": "application/json"}, json.dumps(objeto, ensure_ascii=False))


def _erro_rpc(id_: Any, codigo: int, mensagem: str) -> RespostaHttp:
    return _json(200, {"jsonrpc": "2.0", "id": id_, "error": {"code": codigo, "message": mensagem}})


def _id_valido(valor: Any) -> bool:
    return isinstance(valor, str) or (isinstance(valor, int) and not isinstance(valor, bool))


class Servidor:
    def __init__(self, nome: str, versao: str, ferramentas: list[Any], instrucoes: str = "") -> None:
        self.nome = nome
        self.versao = versao
        self.instrucoes = instrucoes
        self.ferramentas = {f.nome: f for f in ferramentas}
        self.metodos: dict[str, Metodo] = {
            "initialize": self._initialize,
            "ping": self._ping,
            "tools/list": self._tools_list,
            "tools/call": self._tools_call,
        }

    def registrar_metodo(self, nome: str, funcao: Metodo) -> None:
        self.metodos[nome] = funcao

    async def atender(self, metodo_http: str, caminho: str, corpo: str, contexto: Contexto) -> RespostaHttp:
        if caminho.rstrip("/") != "/mcp":
            return RespostaHttp(404)
        if metodo_http != "POST":
            return RespostaHttp(405, {"Allow": "POST"})
        try:
            mensagem = json.loads(corpo)
        except ValueError:
            return _erro_rpc(None, PARSE_ERROR, "JSON inválido")
        return await self._mensagem(mensagem, contexto)

    async def _mensagem(self, mensagem: Any, contexto: Contexto) -> RespostaHttp:
        if not isinstance(mensagem, dict) or mensagem.get("jsonrpc") != "2.0":
            return _erro_rpc(None, INVALID_REQUEST, "Requisição inválida")
        if "method" not in mensagem and ("result" in mensagem or "error" in mensagem):
            return RespostaHttp(202)  # a resposta do cliente a algo nosso: sem estado, nada a fazer
        nome = mensagem.get("method")
        if not isinstance(nome, str):
            return _erro_rpc(None, INVALID_REQUEST, "Requisição inválida")
        if "id" not in mensagem:
            await self._notificacao(nome, mensagem.get("params"), contexto)
            return RespostaHttp(202)
        id_ = mensagem["id"]
        if not _id_valido(id_):
            return _erro_rpc(None, INVALID_REQUEST, "Requisição inválida")
        params = mensagem.get("params", {})
        if not isinstance(params, dict):
            return _erro_rpc(id_, INVALID_PARAMS, "Parâmetros inválidos")
        funcao = self.metodos.get(nome)
        if funcao is None:
            return _erro_rpc(id_, METHOD_NOT_FOUND, "Método desconhecido")
        try:
            resultado = await funcao(params, contexto)
        except ErroDeParametros as e:
            return _erro_rpc(id_, INVALID_PARAMS, str(e) or "Parâmetros inválidos")
        except Exception as e:
            falha_generica(contexto.registrar, f"rpc:{nome}", exception=type(e).__name__)
            return _erro_rpc(id_, INTERNAL_ERROR, "Erro interno")
        return _json(200, {"jsonrpc": "2.0", "id": id_, "result": resultado})

    async def _notificacao(self, nome: str, params: Any, contexto: Contexto) -> None:
        """Notificações (`notifications/initialized` e as demais) não têm resposta; sem estado, nada a guardar."""

    async def _initialize(self, params: dict[str, Any], contexto: Contexto) -> dict[str, Any]:
        pedida = params.get("protocolVersion")
        if not isinstance(pedida, str):
            raise ErroDeParametros("protocolVersion é obrigatório")
        versao = pedida if pedida in VERSOES_SUPORTADAS else VERSOES_SUPORTADAS[0]
        resultado = {
            "protocolVersion": versao,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": self.nome, "version": self.versao},
        }
        if self.instrucoes:
            resultado["instructions"] = self.instrucoes
        return resultado

    async def _ping(self, params: dict[str, Any], contexto: Contexto) -> dict[str, Any]:
        return {}

    async def _tools_list(self, params: dict[str, Any], contexto: Contexto) -> dict[str, Any]:
        tools = []
        for f in self.ferramentas.values():
            tool = {"name": f.nome, "description": f.descricao, "inputSchema": f.esquema_de_entrada}
            if f.meta:
                tool["_meta"] = f.meta
            tools.append(tool)
        return {"tools": tools}

    async def _tools_call(self, params: dict[str, Any], contexto: Contexto) -> dict[str, Any]:
        nome = params.get("name")
        ferramenta = self.ferramentas.get(nome) if isinstance(nome, str) else None
        if ferramenta is None:
            raise ErroDeParametros("Tool desconhecida")
        argumentos = params.get("arguments", {})
        if argumentos is None:
            argumentos = {}
        if not isinstance(argumentos, dict):
            raise ErroDeParametros("arguments deve ser um objeto")
        try:
            if ferramenta.exige_sessao and not (contexto.jwt or "").strip():
                raise sessao_expirada()
            return _resultado(await ferramenta.executar(argumentos, contexto))
        except ErroDeFerramenta as e:
            return _resultado_de_erro(e)
        except Exception as e:
            return _resultado_de_erro(falha_generica(contexto.registrar, nome, exception=type(e).__name__))


def _resultado(saida: dict[str, Any]) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": json.dumps(saida, ensure_ascii=False)}], "structuredContent": saida, "isError": False}


def _resultado_de_erro(erro: ErroDeFerramenta) -> dict[str, Any]:
    saida = {"error": erro.codigo, "message": erro.mensagem, **erro.campos}
    return {"content": [{"type": "text", "text": json.dumps(saida, ensure_ascii=False)}], "structuredContent": saida, "isError": True}
