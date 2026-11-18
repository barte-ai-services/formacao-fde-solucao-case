"""O ponto de entrada do Python Worker: um adaptador fino. Toda a lógica está nos módulos puros (aplicacao.py).

É o único arquivo que importa o pacote `workers` e o FFI do Pyodide, de modo que os módulos puros rodam e são
testados no CPython local."""

import json
from urllib.parse import urlparse

from js import Object
from pyodide.ffi import to_js
from workers import Response, WorkerEntrypoint

import aplicacao
from cliente_api import parsear_resposta

CABECALHO_DO_ACCESS = "Cf-Access-Jwt-Assertion"
# O host não importa no service binding: quem responde é o Worker da API.
ORIGEM_DA_API = "https://api.interna"


class ClienteDoBinding:
    """A porta da API sobre o service binding `API`, repassando o JWT do Access de quem chamou."""

    def __init__(self, binding):
        self.binding = binding

    async def chamar(self, metodo, caminho, jwt, corpo=None):
        cabecalhos = {CABECALHO_DO_ACCESS: jwt, "Accept": "application/json"}
        opcoes = {"method": metodo, "headers": cabecalhos}
        if corpo is not None:
            cabecalhos["Content-Type"] = "application/json"
            opcoes["body"] = json.dumps(corpo)
        resposta = await self.binding.fetch(ORIGEM_DA_API + caminho, to_js(opcoes, dict_converter=Object.fromEntries))
        return parsear_resposta(resposta.status, await resposta.text())


class Default(WorkerEntrypoint):
    async def fetch(self, request):
        jwt = request.headers.get(CABECALHO_DO_ACCESS)
        corpo = await request.text() if request.method == "POST" else ""
        resposta = await aplicacao.atender(
            request.method, urlparse(request.url).path, jwt, corpo, ClienteDoBinding(self.env.API)
        )
        return Response(resposta.corpo or "", status=resposta.status, headers=resposta.cabecalhos)
