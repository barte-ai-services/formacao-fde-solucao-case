"""Erros de negócio das tools e os textos que a pessoa lê (#137)."""

from __future__ import annotations

import uuid
from typing import Any, Callable, Optional

SESSAO_EXPIRADA = "Sua sessão expirou. Entre de novo pelo Access."
FALHA_GENERICA = "Não foi possível concluir agora. Tente de novo em instantes."

NIVEIS_ROTULO = {"analista": "Analista", "coordenacao": "Coordenação", "diretoria": "Diretoria"}


class ErroDeFerramenta(Exception):
    """Uma recusa que a tool devolve à pessoa, com o código da #137 e a mensagem em português.

    O texto é sempre nosso: nunca carrega a mensagem ou o corpo de uma dependência."""

    def __init__(self, codigo: str, mensagem: str, **campos: object) -> None:
        super().__init__(codigo)
        self.codigo = codigo
        self.mensagem = mensagem
        self.campos = campos


class ErroDeParametros(Exception):
    """Parâmetros do JSON-RPC inválidos (-32602): é do protocolo, não da tool."""


def sessao_expirada() -> ErroDeFerramenta:
    return ErroDeFerramenta("session_expired", SESSAO_EXPIRADA)


def falha_generica(registrar: Callable[[dict[str, Any]], None], operacao: str, **detalhe: Optional[object]) -> ErroDeFerramenta:
    """O chamador recebe o erro genérico e um identificador de correlação; o detalhe vai ao log só como campos
    nomeados (operação, status, código do erro, classe da exceção), nunca o texto de um erro nem uma resposta."""
    correlacao = uuid.uuid4().hex[:12]
    campos = {chave: valor for chave, valor in detalhe.items() if valor is not None}
    registrar({"operation": operacao, "correlation_id": correlacao, **campos})
    return ErroDeFerramenta("unavailable", FALHA_GENERICA, correlation_id=correlacao)
