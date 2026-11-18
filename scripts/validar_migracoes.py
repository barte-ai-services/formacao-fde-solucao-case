"""Falha se duas migrações do Supabase têm a mesma versão (o prefixo antes do primeiro _).

Com PRs em paralelo, dois arquivos com o mesmo timestamp passam no CI de cada um e quebram o
db push da main: o segundo bate na chave de supabase_migrations.schema_migrations.
"""

from __future__ import annotations

import sys
from collections import defaultdict
from pathlib import Path

PASTA = Path(__file__).resolve().parent.parent / "supabase" / "migrations"


def repetidas(nomes: list[str]) -> dict[str, list[str]]:
    por_versao: dict[str, list[str]] = defaultdict(list)
    for nome in nomes:
        if nome.endswith(".sql"):
            por_versao[nome.split("_", 1)[0]].append(nome)
    return {v: sorted(ns) for v, ns in por_versao.items() if len(ns) > 1}


def main() -> int:
    achadas = repetidas([p.name for p in PASTA.iterdir()])
    for versao, nomes in sorted(achadas.items()):
        print(f"versão de migração repetida {versao}: {', '.join(nomes)}", file=sys.stderr)
    return 1 if achadas else 0


if __name__ == "__main__":
    sys.exit(main())
