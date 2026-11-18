"""O ponto de entrada do Python Worker: um adaptador fino. Toda a lógica está nos módulos puros (app.py).

É o único arquivo que importa o pacote `workers` e o módulo `js` do runtime, de modo que os módulos
puros rodam e são testados no CPython local; este também é testado ali, com dublês deles (worker_test.py)."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlparse

from js import AbortSignal
from workers import Response, WorkerEntrypoint

import app
from api_client import ApiRequest, ApiResponse, parse_response
from protocol import HttpRequest, Settings

JsProxy = Any  # #272 objeto do runtime JS (Request, Response, service binding), sem tipo estático
ACCESS_HEADER = "Cf-Access-Jwt-Assertion"
# #272 o host não importa no service binding: quem responde é o Worker da API.
API_ORIGIN = "https://api.interna"
# #272 REL-1: o prazo da chamada à API; o estouro é uma falha do binding, que vira `unavailable` para a pessoa.
API_TIMEOUT_MS = 10_000
ALLOWED_ORIGINS_VARIABLE = "MCP_ALLOWED_ORIGINS"


class BindingApiClient:
    """A porta da API sobre o service binding `API`, repassando o JWT do Access de quem chamou."""

    def __init__(self, binding: JsProxy) -> None:
        self.binding = binding

    async def call(self, request: ApiRequest, jwt: str) -> ApiResponse:
        headers = {ACCESS_HEADER: jwt, "Accept": "application/json"}
        options: dict[str, object] = {"method": request.method, "headers": headers, "signal": AbortSignal.timeout(API_TIMEOUT_MS)}
        if request.body is not None:
            headers["Content-Type"] = "application/json"
            options["body"] = json.dumps(request.body)
        # #272 o `env.API` vem embrulhado pelo pacote `workers`: o init entra por palavra-chave, não por posição.
        response = await self.binding.fetch(API_ORIGIN + request.path, **options)
        return parse_response(response.status, await response.text())


class Default(WorkerEntrypoint):
    async def fetch(self, request: JsProxy) -> JsProxy:
        body = await request.text() if request.method == "POST" else ""
        headers = request.headers
        http_request = HttpRequest(
            request.method, urlparse(request.url).path, body, headers.get(ACCESS_HEADER),
            headers.get("Content-Type"), headers.get("Origin"),
        )
        settings = Settings(app.parse_allowed_origins(getattr(self.env, ALLOWED_ORIGINS_VARIABLE, "")))
        reply = await app.handle(http_request, BindingApiClient(self.env.API), app.log_to_console, settings)
        return Response(reply.body or "", status=reply.status, headers=dict(reply.headers))
