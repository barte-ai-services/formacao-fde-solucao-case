"""Eval contra o gabarito: acerto por campo e por tipo de exceção. (#227, vem do kit de domingo)

Uso:
    python3 scripts/avaliar.py saidas/propostas.jsonl
    python3 scripts/avaliar.py saidas/propostas.jsonl --comparar saidas/baseline.jsonl --erros

O gabarito não mora neste repositório (data/kit/contrato.json). Ele vem do kit-domingo do formacao-fde-ops:
por padrão, ../formacao-fde-ops/kit-domingo/dados/gabarito/gabarito.json, ou o que --gabarito ou FDE_GABARITO apontarem.

Uma nota conta como acerto completo quando classificação, ação na doca e encaminhamento batem.
Notas sem proposta contam como erro. Se houver mais de uma proposta para a mesma nota, vale a última.
"""

from __future__ import annotations

import argparse
import json
import os
from collections import defaultdict
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
GABARITO_PADRAO = RAIZ.parent / "formacao-fde-ops" / "kit-domingo" / "dados" / "gabarito" / "gabarito.json"
CLASSIFICACOES = ["match", "E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"]  # as do kit (jachegou/base.py)
CAMPOS = ("classificacao", "acao_doca", "encaminhamento")


def ler_propostas(caminho: Path) -> dict[str, dict]:
    props = {}
    for linha in caminho.read_text(encoding="utf-8").splitlines():
        if linha.strip():
            p = json.loads(linha)
            props[p["nota_id"]] = p
    return props


def avaliar(props: dict[str, dict], gabarito: list[dict]) -> dict:
    por_tipo = defaultdict(lambda: {"total": 0, "classificacao": 0, "completo": 0})
    campo_ok = {c: 0 for c in CAMPOS}
    completo = 0
    risco_ok = risco_n = 0
    confusao = defaultdict(int)
    erros = []
    for g in gabarito:
        p = props.get(g["nota_id"], {})
        t = por_tipo[g["classificacao"]]
        t["total"] += 1
        acertos = {c: p.get(c) == g[c] for c in CAMPOS}
        for c, ok in acertos.items():
            campo_ok[c] += ok
        t["classificacao"] += acertos["classificacao"]
        if all(acertos.values()):
            completo += 1
            t["completo"] += 1
        else:
            erros.append((g, p))
        confusao[(g["classificacao"], p.get("classificacao", "sem proposta"))] += 1
        if p.get("valor_em_risco") is not None:
            risco_n += 1
            risco_ok += abs(float(p["valor_em_risco"]) - g["valor_em_risco"]) <= 1.0
    n = len(gabarito)
    return {"n": n, "completo": completo, "campos": campo_ok, "por_tipo": dict(por_tipo),
            "risco": (risco_ok, risco_n), "confusao": dict(confusao), "erros": erros,
            "cobertura": sum(1 for g in gabarito if g["nota_id"] in props)}


def conferir_base(gabarito: list[dict], notas: list[dict]) -> None:
    """O gabarito só vale para a base de que saiu: confere as chaves de acesso nota a nota."""
    chaves = {n["nota_id"]: n["chave"] for n in notas}
    fora = [g["nota_id"] for g in gabarito if chaves.get(g["nota_id"]) != g["chave"]]
    if fora:
        raise SystemExit(
            f"O gabarito não é desta base: {len(fora)} de {len(gabarito)} notas têm outra chave de acesso "
            f"(por exemplo {fora[0]}). Use o gabarito gerado com a mesma base de data/kit/notas.json, "
            "ou recarregue a base a partir do mesmo kit.")


def pct(a, b):
    return f"{100 * a / b:.0f}%" if b else "—"


def relatorio(nome: str, r: dict, outro: tuple[str, dict] | None = None) -> str:
    n = r["n"]
    linhas = [f"# Eval · {nome}", "",
              f"Notas com proposta: {r['cobertura']} de {n}", "",
              "| Medida | " + nome + (f" | {outro[0]}" if outro else "") + " |",
              "| --- | --- |" + (" --- |" if outro else "")]

    def linha(rotulo, a, b):
        linhas.append(f"| {rotulo} | {a} |" + (f" {b} |" if outro else ""))

    o = outro[1] if outro else None
    linha("Acerto completo (as três skills)", pct(r["completo"], n), pct(o["completo"], n) if o else "")
    for c, rot in zip(CAMPOS, ("Skill 1 · classificação", "Skill 2 · ação na doca", "Skill 3 · encaminhamento")):
        linha(rot, pct(r["campos"][c], n), pct(o["campos"][c], n) if o else "")
    ok, tot = r["risco"]
    linha("Valor em risco (até R$ 1 de diferença)", f"{ok} de {tot}" if tot else "não informado",
          (f"{o['risco'][0]} de {o['risco'][1]}" if o and o["risco"][1] else "não informado") if o else "")
    linhas += ["", "## Por tipo", "", "| Tipo | Notas | Classificação | Completo |" + (f" Completo · {outro[0]} |" if outro else ""),
               "| --- | --- | --- | --- |" + (" --- |" if outro else "")]
    for c in CLASSIFICACOES:
        t = r["por_tipo"].get(c)
        if not t:
            continue
        extra = f" {pct(o['por_tipo'][c]['completo'], t['total'])} |" if o else ""
        linhas.append(f"| {c} | {t['total']} | {pct(t['classificacao'], t['total'])} | {pct(t['completo'], t['total'])} |{extra}")
    trocas = sorted(((k, v) for k, v in r["confusao"].items() if k[0] != k[1]), key=lambda x: -x[1])
    if trocas:
        linhas += ["", "## Confusões mais comuns", ""]
        for (real, prev), v in trocas[:8]:
            linhas.append(f"- {real} classificada como {prev}: {v}")
    return "\n".join(linhas) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("propostas", type=Path)
    ap.add_argument("--comparar", type=Path, help="outro arquivo de propostas, por exemplo o baseline")
    ap.add_argument("--erros", action="store_true", help="lista as notas erradas")
    ap.add_argument("--gabarito", type=Path, default=Path(os.environ.get("FDE_GABARITO", GABARITO_PADRAO)),
                    help="gabarito.json do kit-domingo (padrão: FDE_GABARITO ou o formacao-fde-ops ao lado)")
    ap.add_argument("--base", type=Path, default=RAIZ / "data" / "kit" / "notas.json",
                    help="notas.json da base, para conferir que o gabarito é dela (padrão: data/kit/notas.json)")
    a = ap.parse_args()
    if not a.gabarito.exists():
        raise SystemExit(f"Gabarito não encontrado em {a.gabarito}. Clone o formacao-fde-ops ao lado ou passe --gabarito.")
    gabarito = json.loads(a.gabarito.read_text(encoding="utf-8"))
    if a.base.exists():
        conferir_base(gabarito, json.loads(a.base.read_text(encoding="utf-8")))
    r = avaliar(ler_propostas(a.propostas), gabarito)
    outro = ("baseline", avaliar(ler_propostas(a.comparar), gabarito)) if a.comparar else None
    texto = relatorio(a.propostas.stem, r, outro)
    print(texto)
    if a.erros:
        for g, p in r["erros"]:
            print(f"- {g['nota_id']} ({g['classificacao']}): esperado {g['classificacao']}/{g['acao_doca']}/{g['encaminhamento']}, "
                  f"veio {p.get('classificacao')}/{p.get('acao_doca')}/{p.get('encaminhamento')}")
    destino = RAIZ / "saidas" / f"relatorio_{a.propostas.stem}.md"
    destino.parent.mkdir(exist_ok=True)
    destino.write_text(texto, encoding="utf-8")


if __name__ == "__main__":
    main()
