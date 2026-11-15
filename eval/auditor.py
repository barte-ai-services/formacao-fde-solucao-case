"""Eval do agente auditor de notas contra o gabarito (#239, parte da #154).

Lê só o arquivo de auditorias exportado (uma linha por nota auditada, o contrato do
`record_audit` da #153) e o gabarito; não toca a rede, o banco nem a base do kit.
A medição (`medir`, `diferenca`, `relatorio_md`) é pura; a leitura e a gravação ficam em `main`.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

# Registro e Json: o que vem do JSONL ou do gabarito só tem forma conhecida em execução, por isso `Any`.
Json = Any
Registro = dict[str, Json]

PASTA = Path(__file__).resolve().parent
GABARITO_PADRAO = PASTA / "gabarito" / "gabarito.json"
RODADAS_PADRAO = PASTA / "rodadas"

EXCECOES = ["match", "E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"]
# campo da auditoria, campo do gabarito
CAMPOS = {"classification": "classificacao", "dock_action": "acao_doca", "routing": "encaminhamento"}
SAIDA_E6_PERDIDA = 1
SAIDA_USO = 2


class EntradaInvalida(ValueError):
    """O arquivo de auditorias ou o gabarito não tem o formato esperado."""


def normalizar(classificacao: Json) -> Json:
    return "match" if classificacao == "MATCH" else classificacao


def interpretar(texto: str) -> list[Registro]:
    """Lê o JSONL: ignora linhas em branco; recusa linha que não é objeto ou sem chave."""
    linhas = []
    for numero, bruta in enumerate(texto.splitlines(), start=1):
        if not bruta.strip():
            continue
        try:
            objeto = json.loads(bruta)
        except json.JSONDecodeError as erro:
            raise EntradaInvalida(f"linha {numero}: JSON inválido ({erro.msg})") from erro
        if not isinstance(objeto, dict) or not objeto.get("invoice_access_key"):
            raise EntradaInvalida(f"linha {numero}: falta `invoice_access_key`")
        linhas.append(objeto)
    return linhas


def deduplicar(linhas: list[Registro]) -> list[Registro]:
    """A mesma chave duas vezes: a última linha vale."""
    return list({x["invoice_access_key"]: x for x in linhas}.values())


def _acertos(proposta: Registro | None, nota: Registro) -> dict[str, bool]:
    """Acerto por campo de uma proposta (auditoria ou regra) contra uma nota do gabarito."""
    if proposta is None:
        return {campo: False for campo in CAMPOS}
    return {
        campo: normalizar(proposta.get(campo)) == nota[alvo]
        for campo, alvo in CAMPOS.items()
    }


def _auditoria_valida(linha: Registro | None) -> Registro | None:
    return None if linha is None or linha.get("not_audited") else linha


def _taxa(parte: int, total: int) -> float | None:
    return parte / total if total else None


def _valores(linhas: list[Registro], campo: str) -> Json:
    distintos = sorted({x[campo] for x in linhas if x.get(campo) is not None})
    if not distintos:
        return None
    return distintos[0] if len(distintos) == 1 else distintos


def _erros(gabarito: list[Registro], por_chave: dict[str, Registro]) -> list[dict[str, str]]:
    erros = []
    conhecidas = {nota["chave"] for nota in gabarito}
    for nota in gabarito:
        linha = por_chave.get(nota["chave"])
        if linha is None:
            erros.append({"invoice_access_key": nota["chave"], "reason": "sem auditoria"})
        elif linha.get("not_audited"):
            motivo = linha["not_audited"].get("reason", "sem motivo")
            erros.append({"invoice_access_key": nota["chave"], "reason": f"não auditada: {motivo}"})
    for chave in por_chave:
        if chave not in conhecidas:
            erros.append({"invoice_access_key": chave, "reason": "chave fora do gabarito"})
    return erros


def _contar(gabarito: list[Registro], proposta_de: Callable[[Registro], Registro | None]) -> dict[str, dict[str, int]]:
    """Por exceção do gabarito: total, acertos por campo e acerto completo."""
    contagem = {c: {"total": 0, **{campo: 0 for campo in CAMPOS}, "full": 0} for c in EXCECOES}
    for nota in gabarito:
        acertos = _acertos(proposta_de(nota), nota)
        alvo = contagem[nota["classificacao"]]
        alvo["total"] += 1
        for campo, acertou in acertos.items():
            alvo[campo] += acertou
        alvo["full"] += all(acertos.values())
    return contagem


def _taxas_vs_regra(agente: dict[str, dict[str, int]], regra: dict[str, dict[str, int]], chaves: list[str]) -> Registro:
    def somar(contagem: dict[str, dict[str, int]], campo: str) -> int:
        return sum(contagem[c][campo] for c in chaves)

    total = sum(agente[c]["total"] for c in chaves)
    return {
        "agent_full": _taxa(somar(agente, "full"), total),
        "rule_full": _taxa(somar(regra, "full"), total),
        "agent_classification": _taxa(somar(agente, "classification"), total),
        "rule_classification": _taxa(somar(regra, "classification"), total),
    }


def _vs_baseline(agente: dict[str, dict[str, int]], regra: dict[str, dict[str, int]]) -> Registro:
    return {
        "by_exception": {c: _taxas_vs_regra(agente, regra, [c]) for c in EXCECOES},
        "total": _taxas_vs_regra(agente, regra, EXCECOES),
    }


def _recusas(linhas: list[Registro]) -> tuple[int | None, float | None]:
    """Sem nenhuma chave `refusals` no arquivo as duas métricas não foram medidas (None)."""
    if not any("refusals" in x for x in linhas):
        return None, None
    auditadas = [x for x in linhas if not x.get("not_audited")]
    abaixo = sum(
        1 for x in auditadas for r in x.get("refusals") or [] if r.get("refusal") == "routing_below_regua"
    )
    de_primeira = sum(1 for x in auditadas if not x.get("refusals"))
    return abaixo, _taxa(de_primeira, len(auditadas))


def medir(linhas: list[Registro], gabarito: list[Registro]) -> Registro:
    """Mede as auditorias contra o gabarito. Pura: sem arquivo, relógio nem rede."""
    linhas = deduplicar(linhas)
    por_chave = {x["invoice_access_key"]: x for x in linhas}
    agente = _contar(gabarito, lambda n: _auditoria_valida(por_chave.get(n["chave"])))
    regra = _contar(gabarito, lambda n: (por_chave.get(n["chave"]) or {}).get("rule"))
    total = len(gabarito)
    por_campo = {campo: _taxa(sum(agente[c][campo] for c in EXCECOES), total) for campo in CAMPOS}
    abaixo, de_primeira = _recusas(linhas)
    return {
        "model": _valores(linhas, "model"),
        "prompt_version": _valores(linhas, "prompt_version"),
        "notes_total": total,
        "full_match_rate": _taxa(sum(agente[c]["full"] for c in EXCECOES), total),
        "by_field": por_campo,
        "by_exception": agente,
        "routing_below_regua": abaixo,
        "first_try_routing_rate": de_primeira,
        "errors": _erros(gabarito, por_chave),
        "vs_baseline": _vs_baseline(agente, regra),
    }


def e6_perdida(rodada: Registro) -> bool:
    """Alguma duplicidade (E6) do gabarito não foi classificada E6 pela auditoria."""
    e6 = rodada["by_exception"]["E6"]
    return e6["classification"] < e6["total"]


def _taxa_completa(rodada: Registro, excecao: str) -> float | None:
    contagem = rodada["by_exception"][excecao]
    return _taxa(contagem["full"], contagem["total"])


def _delta(atual: float | None, anterior: float | None) -> float | None:
    return None if atual is None or anterior is None else atual - anterior


def diferenca(atual: Registro, anterior: Registro) -> Registro:
    """Diferença (atual menos anterior) nas taxas; None onde uma das rodadas não mede."""
    return {
        "previous_run_id": anterior["run_id"],
        "full_match_rate": _delta(atual["full_match_rate"], anterior["full_match_rate"]),
        "by_field": {c: _delta(atual["by_field"][c], anterior["by_field"][c]) for c in CAMPOS},
        "by_exception": {
            e: _delta(_taxa_completa(atual, e), _taxa_completa(anterior, e)) for e in EXCECOES
        },
    }


def gerar_run_id(agora: datetime, conteudo: bytes) -> str:
    """Timestamp UTC (ordenável) mais um hash curto do conteúdo do arquivo de auditorias."""
    selo = agora.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{selo}-{hashlib.sha256(conteudo).hexdigest()[:8]}"


def _pct(valor: float | None) -> str:
    return "não medido" if valor is None else f"{valor * 100:.1f}%"


def _pp(valor: float | None) -> str:
    return "n/d" if valor is None else f"{valor * 100:+.1f} p.p."


def _texto_valor(valor: Json) -> str:
    if valor is None:
        return "não informado"
    return ", ".join(valor) if isinstance(valor, list) else str(valor)


def _secao_resumo(r: Registro) -> list[str]:
    abaixo = "não medido" if r["routing_below_regua"] is None else str(r["routing_below_regua"])
    return [
        f"# Auditor de notas, rodada {r['run_id']}",
        "",
        f"- Modelo: {_texto_valor(r['model'])}",
        f"- Versão do prompt: {_texto_valor(r['prompt_version'])}",
        f"- Acerto completo: {_pct(r['full_match_rate'])} ({r['notes_total']} notas)",
        f"- Encaminhamentos abaixo da régua: {abaixo}",
        f"- Encaminhamento certo de primeira: {_pct(r['first_try_routing_rate'])}",
        "",
        "## Por campo",
        "",
        *[f"- {campo}: {_pct(taxa)}" for campo, taxa in r["by_field"].items()],
        "",
    ]


def _secao_excecoes(r: Registro) -> list[str]:
    linhas = ["## Por exceção", "", "| Exceção | Notas | Classificação | Ação na doca | Encaminhamento | Completo |",
              "|---|---|---|---|---|---|"]
    for e in EXCECOES:
        c = r["by_exception"][e]
        linhas.append(
            f"| {e} | {c['total']} | {c['classification']} | {c['dock_action']} | {c['routing']} | {c['full']} |"
        )
    return [*linhas, ""]


def _secao_regra(r: Registro) -> list[str]:
    linhas = ["## Agente contra a regra sem IA", "",
              "| Exceção | Agente (completo) | Regra (completo) | Agente (classificação) | Regra (classificação) |",
              "|---|---|---|---|---|"]
    vb = r["vs_baseline"]
    for nome, v in [*vb["by_exception"].items(), ("Total", vb["total"])]:
        linhas.append(
            f"| {nome} | {_pct(v['agent_full'])} | {_pct(v['rule_full'])} | "
            f"{_pct(v['agent_classification'])} | {_pct(v['rule_classification'])} |"
        )
    return [*linhas, ""]


def _secao_anterior(d: Registro | None) -> list[str]:
    if d is None:
        return ["## Contra a rodada anterior", "", "Sem rodada anterior para comparar.", ""]
    return [
        "## Contra a rodada anterior", "",
        f"Rodada anterior: {d['previous_run_id']}", "",
        f"- Acerto completo: {_pp(d['full_match_rate'])}",
        *[f"- {campo}: {_pp(v)}" for campo, v in d["by_field"].items()],
        "", "| Exceção | Acerto completo |", "|---|---|",
        *[f"| {e} | {_pp(v)} |" for e, v in d["by_exception"].items()],
        "",
    ]


def _secao_erros(r: Registro) -> list[str]:
    if not r["errors"]:
        return ["## Erros", "", "Nenhum.", ""]
    return ["## Erros", "", *[f"- {e['invoice_access_key']}: {e['reason']}" for e in r["errors"]], ""]


def relatorio_md(r: Registro, anterior: Registro | None) -> str:
    """Relatório legível em português; `anterior` é a diferença de `diferenca`, ou None."""
    secoes = [_secao_resumo(r), _secao_excecoes(r), _secao_regra(r), _secao_anterior(anterior), _secao_erros(r)]
    return "\n".join(linha for secao in secoes for linha in secao)


def rodada_anterior(pasta: Path, run_id: str) -> Registro | None:
    """A última rodada gravada com run_id menor que o atual, ou None."""
    if not pasta.is_dir():
        return None
    antes = sorted(a for a in pasta.glob("*.json") if a.stem < run_id)
    if not antes:
        return None
    return json.loads(antes[-1].read_text(encoding="utf-8"))


def _ler_gabarito(caminho: Path) -> list[Registro]:
    try:
        gabarito = json.loads(caminho.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as erro:
        raise EntradaInvalida(f"gabarito ilegível: {caminho}") from erro
    if not isinstance(gabarito, list) or any("chave" not in n for n in gabarito):
        raise EntradaInvalida("gabarito sem `chave` em alguma nota")
    return gabarito


def _argumentos(argv: list[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Mede as auditorias do agente contra o gabarito (#239).")
    p.add_argument("auditorias", type=Path, help="JSONL com uma linha por nota auditada")
    p.add_argument("--gabarito", type=Path, default=GABARITO_PADRAO)
    p.add_argument("--rodadas", type=Path, default=RODADAS_PADRAO, help="pasta onde cada rodada é gravada")
    p.add_argument("--formato", choices=["json", "md"], default="json")
    return p.parse_args(argv)


def _rodar(args: argparse.Namespace, agora: datetime) -> Registro:
    try:
        conteudo = args.auditorias.read_bytes()
    except OSError as erro:
        raise EntradaInvalida(f"auditorias ilegíveis: {args.auditorias}") from erro
    rodada = medir(interpretar(conteudo.decode("utf-8")), _ler_gabarito(args.gabarito))
    rodada = {"run_id": gerar_run_id(agora, conteudo), **rodada}
    anterior = rodada_anterior(args.rodadas, rodada["run_id"])
    if anterior is not None:
        rodada["vs_previous"] = diferenca(rodada, anterior)
    args.rodadas.mkdir(parents=True, exist_ok=True)
    (args.rodadas / f"{rodada['run_id']}.json").write_text(
        json.dumps(rodada, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return rodada


def main(argv: list[str] | None = None, agora: Callable[[], datetime] | None = None) -> int:
    """0 sem E6 perdida; 1 com E6 perdida; 2 para entrada ou uso inválidos."""
    try:
        args = _argumentos(sys.argv[1:] if argv is None else argv)
    except SystemExit as saida:  # argparse sai com 0 em --help e com 2 em uso inválido
        return saida.code if isinstance(saida.code, int) else SAIDA_USO
    try:
        rodada = _rodar(args, (agora or (lambda: datetime.now(timezone.utc)))())
    except (EntradaInvalida, UnicodeDecodeError) as erro:
        print(f"erro: {erro}", file=sys.stderr)
        return SAIDA_USO
    if args.formato == "md":
        print(relatorio_md(rodada, rodada.get("vs_previous")))
    else:
        print(json.dumps(rodada, ensure_ascii=False, indent=2))
    if e6_perdida(rodada):
        print("falha: alguma duplicidade (E6) do gabarito não foi classificada como E6", file=sys.stderr)
        return SAIDA_E6_PERDIDA
    return 0


if __name__ == "__main__":
    sys.exit(main())
