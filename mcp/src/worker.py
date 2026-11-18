"""O ponto de entrada do Python Worker: um adaptador fino. Toda a lógica está nos módulos puros (app.py).

É o único arquivo que importa o pacote `workers` e o FFI do Pyodide, de modo que os módulos puros rodam e são
testados no CPython local; este também é testado ali, com dublês dos módulos do runtime (worker_test.py)."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlparse

from js import Object
from pyodide.ffi import to_js
from workers import Response, WorkerEntrypoint

import app
from api_client import ApiRequest, ApiResponse, parse_response
from json_types import JsonObject
from protocol import HttpRequest

JsProxy = Any  # #272 objeto do runtime JS (Request, Response, service binding), sem tipo estático
ACCESS_HEADER = "Cf-Access-Jwt-Assertion"
# #272 o host não importa no service binding: quem responde é o Worker da API.
API_ORIGIN = "https://api.interna"


class BindingApiClient:
    """A porta da API sobre o service binding `API`, repassando o JWT do Access de quem chamou."""

    def __init__(self, binding: JsProxy) -> None:
        self.binding = binding

    async def call(self, request: ApiRequest, jwt: str) -> ApiResponse:
        headers = {ACCESS_HEADER: jwt, "Accept": "application/json"}
        options: JsonObject = {"method": request.method, "headers": headers}
        if request.body is not None:
            headers["Content-Type"] = "application/json"
            options["body"] = json.dumps(request.body)
        response = await self.binding.fetch(API_ORIGIN + request.path, to_js(options, dict_converter=Object.fromEntries))
        return parse_response(response.status, await response.text())


class Default(WorkerEntrypoint):
    async def fetch(self, request: JsProxy) -> JsProxy:
        body = await request.text() if request.method == "POST" else ""
        http_request = HttpRequest(request.method, urlparse(request.url).path, body, request.headers.get(ACCESS_HEADER))
        reply = await app.handle(http_request, BindingApiClient(self.env.API))
        return Response(reply.body or "", status=reply.status, headers=dict(reply.headers))
