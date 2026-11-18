"""Validação das entradas das tools (#137). Recusa antes de chamar a API o que já se sabe inválido."""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Optional

from erros import ErroDeFerramenta

CHAVE_DE_ACESSO = re.compile(r"^[0-9]{44}$")
CLASSIFICACOES = ("E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8", "NAO_CATALOGADA")
NIVEIS = ("analista", "coordenacao", "diretoria", "bloqueio")
ACOES = ("receber", "receber_parcial", "recusar")
UNIDADES = ("UN", "CX")
DESTINOS = ("segurar", "devolver")


def _invalida(mensagem: str) -> ErroDeFerramenta:
    return ErroDeFerramenta("invalid_input", mensagem)


def _lista_de(args: dict[str, Any], campo: str, permitidos: tuple[str, ...]) -> Optional[list[str]]:
    valor = args.get(campo)
    if valor is None:
        return None
    if not isinstance(valor, list) or not all(isinstance(v, str) and v in permitidos for v in valor):
        raise _invalida(f"{campo} deve ser uma lista com valores de {', '.join(permitidos)}.")
    return valor


@dataclass(frozen=True)
class FiltrosDaFila:
    escopo: str
    classificacoes: Optional[list[str]]
    niveis: Optional[list[str]]


def validar_fila(args: dict[str, Any]) -> FiltrosDaFila:
    escopo = args.get("scope", "mine")
    if escopo not in ("mine", "all"):
        raise _invalida("scope deve ser mine ou all.")
    return FiltrosDaFila(escopo, _lista_de(args, "classification", CLASSIFICACOES), _lista_de(args, "level", NIVEIS))


def validar_chave_de_leitura(args: dict[str, Any]) -> str:
    chave = args.get("invoice_access_key")
    if not isinstance(chave, str) or not CHAVE_DE_ACESSO.match(chave):
        raise _invalida("invoice_access_key deve ter 44 dígitos.")
    return chave


@dataclass(frozen=True)
class Decisao:
    chave: str
    decisao: str  # approve ou change
    acao_na_doca: Optional[dict[str, Any]]  # só com change, já no formato da API (camelCase não muda: kind, lines)
    justificativa: Optional[str]


def _acao_invalida(mensagem: str) -> ErroDeFerramenta:
    return ErroDeFerramenta("invalid_dock_action", mensagem)


def _numero_positivo(valor: object) -> bool:
    return isinstance(valor, (int, float)) and not isinstance(valor, bool) and valor > 0


def _linha_parcial(linha: object) -> dict[str, Any]:
    if not isinstance(linha, dict):
        raise _acao_invalida("Cada linha deve ser um objeto com sku, quantity e disposition.")
    quantidade = linha.get("quantity")
    sku = linha.get("sku")
    if not isinstance(sku, str) or not sku.strip():
        raise _acao_invalida("Cada linha traz o sku.")
    if not isinstance(quantidade, dict) or not _numero_positivo(quantidade.get("amount")) or quantidade.get("unit") not in UNIDADES:
        raise _acao_invalida("Cada linha traz a quantidade positiva em UN ou CX.")
    if linha.get("disposition") not in DESTINOS:
        raise _acao_invalida("Cada linha diz se segura ou devolve.")
    return {
        "sku": sku,
        "quantity": {"amount": quantidade["amount"], "unit": quantidade["unit"]},
        "disposition": linha["disposition"],
    }


def validar_acao_na_doca(bruta: object) -> dict[str, Any]:
    tipo = bruta.get("kind") if isinstance(bruta, dict) else None
    if tipo not in ACOES:
        raise _acao_invalida("dock_action.kind deve ser receber, receber_parcial ou recusar.")
    if tipo != "receber_parcial":
        return {"kind": tipo}
    linhas = bruta.get("lines")
    if not isinstance(linhas, list) or not linhas:
        raise _acao_invalida("Receber parcial exige as linhas (lines).")
    return {"kind": tipo, "lines": [_linha_parcial(l) for l in linhas]}


def validar_decisao(args: dict[str, Any]) -> Decisao:
    chave = args.get("invoice_access_key")
    if not isinstance(chave, str) or not CHAVE_DE_ACESSO.match(chave):
        raise _acao_invalida("invoice_access_key deve ter 44 dígitos.")
    decisao = args.get("decision")
    if decisao not in ("approve", "change"):
        raise _invalida("decision deve ser approve ou change.")
    evidencias = args.get("weighed_evidence")
    if evidencias is not None and (not isinstance(evidencias, list) or not all(isinstance(e, str) for e in evidencias)):
        raise _invalida("weighed_evidence deve ser uma lista de textos.")
    if decisao == "approve":
        return Decisao(chave, decisao, None, None)
    justificativa = args.get("justification")
    if not isinstance(justificativa, str) or not justificativa.strip():
        raise ErroDeFerramenta("justification_required", "Para alterar, escreva o porquê.")
    return Decisao(chave, decisao, validar_acao_na_doca(args.get("dock_action")), justificativa.strip())
